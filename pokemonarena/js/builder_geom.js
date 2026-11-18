// pokemonarena/js/builder_geom.js -- THE TEAM BUILDER's geometry: where every piece of every builder screen stands in the 240x160 picture, shared by the state machine (hit tests) and the renderer (drawing),
// so a tap always lands on what is drawn there.
//
// Pure ES module (browser + Node): numbers and a few rectangle helpers, no imports. Every builder screen is laid out from the same three bands:
//
//   STRIP   y 0..13    the screen's title on the left, its chips in the middle (MENU, the tabs, FILTER / page up / page down), the autosave tag on the right
//   BODY    y 14..111  a LIST (seven rows, 12 px apart, in a ROM window) with a SIDE window beside it, or a WIDE list, or the team's six slot panels and a chip row, or the Pokemon's picture and its list
//   MSG     y 112..159 the ROM message box: what the highlighted thing is, or why something was refused
//
// A list row's text is drawn at the row's own y (the ROM font keeps its ink in rows 3..14 of its 16 px cell), so seven rows need 7 * 12 + 3 pixels (LIST_H).

export const SCREEN_W = 240, SCREEN_H = 160;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const inR = (r, x, y) => !!r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

const fz = Object.freeze;
export const BG = fz({
  strip: fz({ h: 14, title: fz({ x: 4, y: -2, w: 130 }), tag: fz({ right: 236, y: -2, w: 46 }), chip: fz({ x: 138, y: 0, w: 48, h: 14 }),
    // the three chips of a picker: FILTER, a page up, a page down (a picker shows no autosave tag: nothing is edited until a row is taken)
    pick: fz([fz({ id: 'filter', x: 130, y: 0, w: 50, h: 14 }), fz({ id: 'pgup', x: 183, y: 0, w: 26, h: 14 }), fz({ id: 'pgdn', x: 211, y: 0, w: 26, h: 14 })]) }),
  list: fz({ x: 12, y: 19, w: 124, pitch: 12, rows: 7 }),          // the list beside a side window (interior)
  wide: fz({ x: 12, y: 19, w: 216, pitch: 12, rows: 7 }),          // a list that takes the whole width
  side: fz({ x: 148, y: 19, w: 80, h: 87 }),                       // the side window (interior)
  msg: fz({ x: 0, y: 112, w: 240, h: 48 }),                        // the ROM message box: a tap on it turns the page of a long text
  popup: fz({ right: 228, bottom: 106, pitch: 14, pitchTight: 12, lead: 11, tail: 6, min: 56, max: 212 }),          // a pop-up menu's interior: its right and bottom edges, the row pitch (12 px from seven rows on), the room the cursor takes, the room right of a label
  team: fz({ cols: fz([6, 122]), rows: fz([16, 40, 64]), w: 112, h: 22, chips: fz({ x: 4, y: 92, w: 232, h: 16, gap: 3 }), status: fz({ x: 108, y: -2, w: 78 }), name: fz({ x: 4, y: -2, w: 100 }) }),
  // (the Pokemon screen's list is as wide as the longest ability name of the ROM needs between the two arrows: builder_test.mjs measures every one)
  mon: fz({ name: fz({ x: 4, y: -2, w: 66 }), tabs: fz({ x: 74, y: 0, w: 36, h: 14, gap: 2 }), sprite: fz({ x: 1, y: 14 }), badges: fz({ x: 1, y: 80 }), info: fz({ x: 1, y: 95, w: 64 }),
    list: fz({ x: 72, y: 19, w: 156, pitch: 12, rows: 7 }), note: fz({ x: 72, y: 19, w: 156, h: 87 }) }),
});
/** The height of a list window's interior. */
export const listH = (g) => g.rows * g.pitch + 3;
/** The rectangle a pointer takes for row `i` of a list (a little wider than the window, like the hub's menus). */
export const rowRect = (g, i) => ({ x: g.x - 4, y: g.y + i * g.pitch, w: g.w + 8, h: g.pitch });
/** The six slot panels of the team screen, left to right, top to bottom. */
export function slotRects() { const T = BG.team, out = []; for (const y of T.rows) for (const x of T.cols) out.push({ x, y, w: T.w, h: T.h }); return out; }
/** `n` chips sharing the team screen's chip row. */
export function chipRects(n) {
  const c = BG.team.chips, k = Math.max(1, n), w = Math.floor((c.w - (k - 1) * c.gap) / k);
  return Array.from({ length: n }, (_, i) => ({ x: c.x + i * (w + c.gap), y: c.y, w, h: c.h }));
}
/** The tab chips of the Pokemon screen. */
export function tabRects(n) { const t = BG.mon.tabs; return Array.from({ length: n }, (_, i) => ({ x: t.x + i * (t.w + t.gap), y: t.y, w: t.w, h: t.h })); }
/** A pop-up menu's interior and rows for `n` rows of inner width `w`: anchored to the right, growing upwards from the foot of the body. */
export function popupRect(n, w) {
  const P = BG.popup, pitch = n > 6 ? P.pitchTight : P.pitch, ww = clamp(Math.ceil(w), P.min, P.max), h = n * pitch + 3, x = P.right - ww, y = P.bottom - h;
  return { x, y, w: ww, h, pitch, rows: Array.from({ length: n }, (_, i) => ({ x: x - 4, y: y + i * pitch, w: ww + 8, h: pitch })) };
}
