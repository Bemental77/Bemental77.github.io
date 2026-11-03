// pokemonarena/js/page_draw.js -- draws a PAGE (recap_model.js / record_model.js: lines of positioned text cells and small icons) inside a ROM window.
//
// Pure ES module (browser + Node): no DOM, no timers. Everything it draws comes from the ROM through the renderer it is given (battle_ui.js createBattleUi):
// the window ring (ui.drawWindow), the fonts (ui.assets.drawText), the text colours (the ROM's 16 text colours), the menu icons (ui.drawIcon). The only
// rectangle it paints is the window's plain white interior, as every ROM window here has.
//
//   const pd = createPageDrawer(ui);
//   pd.drawWindowPage(frame, page, { x: 10, y: 20, w: 220, h: 106 });     // ring + white interior + the page's text
//   pd.fit(cell)  ->  { font, text, w, cut }                              // how a cell is actually set (the font ladder, then a cut as the last resort)
//
// FIT RULE. A cell is set in the font it asks for ('normal' or 'small'); if the text is wider than the cell it steps down the ladder to a narrower ROM font
// ('normal' -> 'narrow' -> 'smallNarrow'; 'small' -> 'smallNarrow'); a text that is still too wide is cut at the cell's edge (cut = true), never drawn into the
// neighbouring cell. The tests prove that no real page cuts anything (cut is false for every cell of every page they build).

const LADDER = { normal: ['normal', 'narrow', 'smallNarrow'], small: ['small', 'smallNarrow'], narrow: ['narrow', 'smallNarrow'], smallNarrow: ['smallNarrow'] };

export function createPageDrawer(ui) {
  const TEXT = ui.TEXT, COL = ui.COL, A = ui.assets;
  const tc = A.textColors();
  // tone -> text colour, all from the ROM: dark (text palette 12), dim = the grey of a disabled row (11), bad = the dark red (2), hi = the brown (4), good = the textbox blue
  const TONE = { dark: TEXT.dark, dim: tc[11], bad: tc[2], hi: tc[4], good: COL.blue };
  const width = (font, s) => ui.measure(font, s);

  function fit(c) {
    const s = ui.safeText(String(c.t));
    const ladder = LADDER[c.f] || LADDER.small;
    for (const font of ladder) { const w = width(font, s); if (w <= c.w) return { font, text: s, w, cut: false }; }
    const font = ladder[ladder.length - 1];
    let t = s;
    while (t.length > 0 && width(font, t) > c.w) t = t.slice(0, -1);
    return { font, text: t, w: width(font, t), cut: true };
  }
  function drawCell(frame, c, ox, oy, y) {
    if (c.t === '') return;
    const r = fit(c);
    const x = c.a === 'r' ? c.x + c.w - r.w : c.a === 'c' ? c.x + Math.floor((c.w - r.w) / 2) : c.x;
    frame.blitRoles(A.drawText(r.font, r.text), ox + x, oy + y, TONE[c.tone] || TEXT.dark, TEXT.shadow);
  }
  function drawPage(frame, page, ox, oy, o = {}) {
    for (const ic of page.icons || []) if (ui.drawIcon) ui.drawIcon(frame, ic.sp, ox + ic.x, oy + ic.y, { bob: o.bob | 0, shiny: !!ic.shiny });
    for (const l of page.lines) for (const c of l.cells) drawCell(frame, c, ox, oy, l.y);
  }
  function drawWindowPage(frame, page, rect, o) {
    ui.drawWindow(frame, rect.x, rect.y, rect.w, rect.h);
    drawPage(frame, page, rect.x, rect.y, o);
  }
  return { fit, drawPage, drawWindowPage, tones: Object.keys(TONE), width };
}
