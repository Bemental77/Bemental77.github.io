// pokemonarena/js/trainer_geom.js -- THE TRAINER app's geometry: where every piece of the new-trainer screens, the trainer card and the one-choice editor stands in the 240x160 picture,
// shared by the state machine (trainer_hub.js: hit tests, taps) and the renderer (trainer_screen.js: drawing), so a tap always lands on what is drawn there.
//
// Pure ES module (browser + Node): numbers and rectangle helpers, no imports. Every rectangle that holds a ROM window is the window's INTERIOR (ui.drawWindow puts its 6 px ring outside).
//
//   STRIP   y 0..13    the screen's title (the ROM font, white on the party-menu teal) and, on a picker, its page chips
//   BODY    y 14..111  the step's list / grid / pictures, or the TRAINER CARD and its chip row
//   MSG     y 112..159 the ROM message box

export const SCREEN_W = 240, SCREEN_H = 160;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const inR = (r, x, y) => !!r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

const fz = Object.freeze;
export const TG = fz({
  strip: fz({ title: fz({ x: 4, y: -2 }), pgup: fz({ id: 'pgup', x: 183, y: 0, w: 26, h: 14 }), pgdn: fz({ id: 'pgdn', x: 211, y: 0, w: 26, h: 14 }) }),
  msg: fz({ x: 0, y: 112, w: 240, h: 48 }),
  // a list beside a side window (NAME, PARTNER): six rows 14 px apart in a ROM window; the side window holds a 64x64 picture and a line under it
  list: fz({ x: 12, y: 18, w: 124, pitch: 14, rows: 6 }),
  side: fz({ x: 148, y: 18, w: 80, h: 87, pic: fz({ x: 156, y: 20 }), line: fz({ y: 86 }) }),
  // the LOOK grid: the ROM's 16x32 overworld trainers, eight across and two down, in one ROM window
  grid: fz({ x: 8, y: 20, w: 224, h: 82, cols: 8, rows: 2, cw: 28, ch: 40, top: 1 }),
  // the PICTURE pickers (battle figure front and back, portrait): three 64x64 pictures in three ROM windows, a chip under each (the Team Builder's portrait picker's places)
  pics: fz({ per: 3, cols: fz([12, 88, 164]), y: 20, w: 64, h: 64, chip: fz({ y: 93, h: 14 }) }),
  // THE TRAINER CARD: one ROM window; the name on its top line (the record at its right), then the look (a 16x32 walker) and three 64x64 pictures: the portrait, the battle figure, the partner
  card: fz({ x: 8, y: 8, w: 224, h: 80, name: fz({ x: 32, y: 8, w: 132, h: 15 }), rec: fz({ right: 230, y: 10, w: 64 }), look: fz({ x: 9, y: 23, w: 22, h: 64 }),
    walker: fz({ x: 12, y: 39 }), portrait: fz({ x: 34, y: 23, w: 64, h: 64 }), figure: fz({ x: 101, y: 23, w: 64, h: 64 }), partner: fz({ x: 168, y: 23, w: 64, h: 64 }) }),
  chips: fz({ x: 8, y: 96, w: 224, h: 14, gap: 4 }),
  // the SWITCH TRAINER list: a ROM window over the card, up to eight names
  switcher: fz({ x: 64, y: 10, w: 112, pitch: 12, rows: 8 }),
  // the welcome: where the Pokemon stands (the middle of its 64x64 picture) over the hub's terrain
  stand: fz({ cx: 120, cy: 52 }),
  // the welcome's own options window (only when the hub's dialog layer could not show the question): above the message box at the right, as the dialog layer puts it
  ask: fz({ x: 150, y: 66, w: 72, pitch: 16 }),
});
/** The rectangle a pointer takes for row `i` of a list window (a little wider than the window, like the hub's menus). */
export const rowRect = (g, i) => ({ x: g.x - 4, y: g.y + i * g.pitch, w: g.w + 8, h: g.pitch });
/** The interior height of a list window of `g.rows` rows. */
export const listH = (g) => g.rows * g.pitch + 3;
/** Cell `i` (0..cols*rows-1) of the LOOK grid: { x, y, w, h }. */
export function gridCell(i) { const G = TG.grid; return { x: G.x + (i % G.cols) * G.cw, y: G.y + G.top + Math.floor(i / G.cols) * G.ch, w: G.cw, h: G.ch }; }
/** The three cells of a picture picker, left to right: `cell` (what a pointer takes), `pic` (the 64x64 picture, a ROM window's interior) and `chip` (under it). */
export function picCells() {
  const P = TG.pics;
  return P.cols.map((x) => ({ cell: { x: x - 6, y: P.y - 6, w: P.w + 12, h: P.chip.y + P.chip.h - P.y + 6 }, pic: { x, y: P.y, w: P.w, h: P.h }, chip: { x, y: P.chip.y, w: P.w, h: P.chip.h } }));
}
/** `n` chips sharing the card's chip row, left to right. */
export function chipRow(n) {
  const c = TG.chips, k = Math.max(1, n), w = Math.floor((c.w - (k - 1) * c.gap) / k);
  return Array.from({ length: n }, (_, i) => ({ x: c.x + i * (w + c.gap), y: c.y, w, h: c.h }));
}
/** The card's parts a pointer can take, by id: name, look, portrait, figure, partner. */
export const CARD_PARTS = fz(['name', 'look', 'portrait', 'figure', 'partner']);
export const cardRect = (id) => { const r = TG.card[id]; return { x: r.x, y: r.y, w: r.w, h: r.h }; };
