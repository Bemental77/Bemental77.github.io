// pokemonarena/js/trainer_screen.js -- draws THE TRAINER app (trainer_hub.js view -> pixels): the new-trainer screens, the TRAINER CARD and the one-choice editor.
//
// Pure ES module (browser + Node): no DOM, no timers. hub_screen.js gives this module the frame `f` (the hub's terrain picture already on it) and its drawing helpers `h`
// (pokemonarena/INAPP.md "The app interface"); the text entry and the dialog layer are drawn by hub_screen.js over what is drawn here.
//
// EVERY PIXEL IS THE ROM'S: the party-menu teal behind the screens (the welcome stands on the hub's terrain), the ROM's 6 px window ring, the ROM's party-menu chip (normal / selected / grey),
// the ROM fonts and their cursor / arrow glyphs, the ROM message box, the ROM's overworld trainers (world_rom.js through center_world.js: the walk in place), the ROM's trainer FRONT and BACK
// pictures and its 52 trainer heads (speciesgfx.js), the ROM's Pokemon front sprites (ui.sprite). No picture is made in code, nothing is recoloured, and nothing is ever scaled.
// Every picture is decoded the first time a frame shows it, and kept.
//
//   render(f, view)        draw a trainer view
//   measure(f, view)       draw it and say what was written: [{ what, s, font, px, max, cut }] for EVERY text (px: its full width; max: the room it had; cut: it did not fit). The tests
//                          check "every text fits its window" with it, at the longest values

import { centerWorld } from './center_world.js';
import { trainerFront, trainerBack, trainerHead, TRAINER_FRONT_COUNT, TRAINER_BACK_COUNT, TRAINER_HEAD_COUNT } from './speciesgfx.js';
import { bitmapToRGBA } from './gfxcodec.js';
import { TG, listH, gridCell, picCells } from './trainer_geom.js';

export const FONTS = Object.freeze(['normal', 'narrow', 'smallNarrow']);

export function createScreen(ui, h) {
  const TEXT = ui.TEXT, COL = ui.COL, R = ui.R;
  let probe = null;
  const pics = new Map();
  /** A decoded picture by key, made once (a cap keeps the cache small: a picker shows three at a time). */
  function memo(key, make) {
    if (pics.has(key)) return pics.get(key);
    let v = null;
    try { v = make(); } catch (_e) { v = null; }
    if (pics.size > 600) pics.delete(pics.keys().next().value);
    pics.set(key, v);
    return v;
  }
  const rgbaOf = (bm, pal) => ({ width: bm.width, height: bm.height, rgba: bitmapToRGBA(bm, pal, { transparent0: true }) });
  const front = (pic) => (Number.isInteger(pic) && pic >= 0 && pic < TRAINER_FRONT_COUNT ? memo('f' + pic, () => { const t = trainerFront(ui.rom, pic); return rgbaOf(t.bitmap, t.palette); }) : null);
  const back = (i) => (Number.isInteger(i) && i >= 0 && i < TRAINER_BACK_COUNT ? memo('b' + i, () => { const t = trainerBack(ui.rom, i); return rgbaOf(t.frames[0], t.palette); }) : null);
  const head = (i) => (Number.isInteger(i) && i >= 0 && i < TRAINER_HEAD_COUNT ? memo('h' + i, () => { const t = trainerHead(ui.rom, i); return rgbaOf(t.bitmap, t.palette); }) : null);
  let world = null;
  const walker = (gfx, step) => (Number.isInteger(gfx) ? memo('w' + gfx + ':' + step, () => { if (!world) world = centerWorld(ui.rom).world; return world.ow.walker(gfx, 'down', step); }) : null);
  const mon = (species) => (Number.isInteger(species) && species > 0 ? memo('m' + species, () => ui.sprite(species, 'foe', { frame: 0 })) : null);
  const put = (f, img, x, y) => { if (img && img.rgba) f.blit(img.width || 64, img.height || 64, img.rgba, x, y); return !!img; };

  /* ---------------------------------------------------------------------------------------- text: EVERY text goes through t() (so measure() sees each one with its room) */
  function t(f, o) {
    const s = ui.safeText(String(o.s === undefined || o.s === null ? '' : o.s));
    const fonts = o.fonts || [o.font || 'normal'];
    const font = o.max ? h.fitFont(s, o.max, fonts) : fonts[0];
    const full = h.width(font, s);
    let shown = s, px = full;
    if (o.max && full > o.max) { shown = h.fitText(font, s, o.max); px = h.width(font, shown); }
    const x = Math.floor(o.align === 'right' ? o.x - px : o.align === 'centre' ? o.x - px / 2 : o.x);
    h.text(f, font, shown, x, o.y, o.fg, o.sh);
    if (probe) probe.push({ what: o.what || 'text', s, font, px: full, max: o.max === undefined ? null : o.max, cut: shown !== s });
    return { font, px, x };
  }
  const onTeal = { fg: TEXT.white, sh: TEXT.dark };
  const bg = (f) => f.rect(0, 0, h.SCREEN_W, h.SCREEN_H, ui.partyArt().bg);
  function chip(f, c) {
    ui.panel(f, c.x, c.y, c.w, c.h, c.off ? 'grey' : c.on ? 'sel' : 'normal', true);
    t(f, { s: c.label, x: c.x + c.w / 2, y: c.y + (c.h >= 16 ? 0 : -1), align: 'centre', max: c.w - 6, fonts: FONTS, fg: c.off ? COL.line : TEXT.dark, sh: TEXT.shadow, what: 'chip ' + c.label });
  }
  function strip(f, v) {
    const chips = v.chips || [];
    const edge = chips.length ? Math.min(...chips.map((c) => c.x)) - 4 : 236;
    t(f, { s: v.title, x: TG.strip.title.x, y: TG.strip.title.y, max: edge - TG.strip.title.x, fonts: FONTS, ...onTeal, what: 'title' });
    for (const c of chips) chip(f, c);
  }
  function message(f, view) {
    const lines = view.msg || ['', ''];
    h.drawMessage(f, lines.map((ln) => ui.safeText(String(ln || ''))));
    if (probe) lines.forEach((ln) => probe.push({ what: 'msg', s: ln, font: 'normal', px: ln ? h.width('normal', ui.safeText(ln)) : 0, max: R.msg.w - 4, cut: false }));
  }

  /* ---------------------------------------------------------------------------------------- the screens */
  function drawWelcome(f, v, view) {
    const sp = mon(v.species);
    if (sp) f.blit(64, 64, sp.rgba, TG.stand.cx - 32, TG.stand.cy - 32 + (sp.yOffset | 0) - (sp.elevation | 0));
    if (v.ask) {
      message(f, view);
      const A = TG.ask;
      ui.drawWindow(f, A.x, A.y, A.w, v.ask.options.length * A.pitch);
      v.ask.options.forEach((o, i) => {
        t(f, { s: o, x: A.x + 12, y: A.y + i * A.pitch + 1, max: A.w - 14, fonts: FONTS, what: 'ask option' });
        if (i === v.ask.cursor) t(f, { s: '{CURSOR}', x: A.x + 2, y: A.y + i * A.pitch + 1, what: 'cursor' });
      });
    }
  }
  function drawWait(f, v, view) {
    bg(f); strip(f, v);
    const r = { x: 60, y: 44, w: 120, h: 16 };
    ui.drawWindow(f, r.x, r.y, r.w, r.h);
    t(f, { s: v.line || 'LOADING...', x: 120, y: r.y, align: 'centre', max: r.w - 4, fonts: FONTS, what: 'wait' });
    message(f, view);
  }
  function drawList(f, v, view) {
    bg(f); strip(f, v);
    const G = TG.list;
    ui.drawWindow(f, G.x, G.y, G.w, listH(G));
    v.rows.forEach((row, i) => {
      const y = G.y + i * G.pitch + 1;
      t(f, { s: row.label, x: G.x + 12, y, max: G.w - 24, fonts: FONTS, what: 'row' });
      if (i === v.cursor) t(f, { s: '{CURSOR}', x: G.x + 2, y, what: 'cursor' });
    });
    if (v.up) t(f, { s: '{UP}', x: G.x + G.w - 10, y: G.y + 1, what: 'arrow' });
    if (v.down) t(f, { s: '{DOWN}', x: G.x + G.w - 10, y: G.y + (G.rows - 1) * G.pitch + 1, what: 'arrow' });
    const D = TG.side;
    ui.drawWindow(f, D.x, D.y, D.w, D.h);
    const sd = v.side || {};
    if (sd.what === 'front') put(f, front(sd.id), D.pic.x, D.pic.y);
    else if (sd.what === 'mon') { const sp = mon(sd.id); if (sp) f.blit(64, 64, sp.rgba, D.pic.x, D.pic.y); }
    if (sd.line) t(f, { s: sd.line, x: D.x + D.w / 2, y: D.line.y, align: 'centre', max: D.w - 2, fonts: FONTS, what: 'side line' });
    message(f, view);
  }
  function drawGrid(f, v, view) {
    bg(f); strip(f, v);
    const G = TG.grid;
    ui.drawWindow(f, G.x, G.y, G.w, G.h);
    v.items.forEach((gfx, i) => {
      const r = gridCell(i), on = i === v.cursor;
      if (on) ui.panel(f, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 'sel', true);
      const s = walker(gfx, on ? v.walk | 0 : 0);
      if (s) f.blit(s.width, s.height, s.rgba, r.x + Math.floor((r.w - s.width) / 2), r.y + Math.floor((r.h - s.height) / 2));
    });
    message(f, view);
  }
  function drawPics(f, v, view) {
    bg(f); strip(f, v);
    const cells = picCells();
    v.cells.forEach((c, i) => {
      const g = cells[i];
      ui.drawWindow(f, g.pic.x, g.pic.y, g.pic.w, g.pic.h);
      put(f, v.what === 'front' ? front(c.id) : v.what === 'back' ? back(c.id) : head(c.id), g.pic.x, g.pic.y);
      ui.panel(f, g.chip.x, g.chip.y, g.chip.w, g.chip.h, c.on ? 'sel' : 'normal', true);
      t(f, { s: c.label, x: g.chip.x + g.chip.w / 2, y: g.chip.y - 1, align: 'centre', max: g.chip.w - 6, fonts: FONTS, fg: TEXT.dark, sh: TEXT.shadow, what: 'pic label' });
    });
    message(f, view);
  }
  function drawCard(f, v, view) {
    bg(f);
    const C = TG.card;
    ui.drawWindow(f, C.x, C.y, C.w, C.h);
    if (v.empty || !v.card) {
      t(f, { s: 'NO TRAINER YET', x: C.x + C.w / 2, y: C.y + 32, align: 'centre', max: C.w - 8, fonts: FONTS, what: 'empty card' });
    } else {
      const c = v.card, hl = (id) => { if (v.focus !== id) return; const r = C[id]; ui.panel(f, r.x - 1, r.y - 1, r.w + 2, r.h + 2, 'sel', true); };
      for (const id of ['name', 'look', 'portrait', 'figure', 'partner']) hl(id);
      t(f, { s: c.name, x: C.name.x + 2, y: C.name.y - 1, max: C.name.w - 4, fonts: FONTS, what: 'card name' });
      if (c.rec) t(f, { s: c.rec, x: C.rec.right, y: C.rec.y, align: 'right', font: 'small', max: C.rec.w, fg: COL.line, what: 'card record' });
      const s = walker(c.look, v.focus === 'look' ? v.walk | 0 : 0);
      if (s) f.blit(s.width, s.height, s.rgba, C.walker.x, C.walker.y);
      put(f, head(c.head), C.portrait.x, C.portrait.y);
      put(f, front(c.front), C.figure.x, C.figure.y);
      const sp = mon(c.partner);
      if (sp) f.blit(64, 64, sp.rgba, C.partner.x, C.partner.y);
    }
    for (const c of v.chips || []) chip(f, c);
    message(f, view);
    if (v.sw) {
      const W = TG.switcher, n = v.sw.rows.length;
      ui.drawWindow(f, W.x, W.y, W.w, n * W.pitch + 3);
      v.sw.rows.forEach((r, i) => {
        const y = W.y + i * W.pitch;
        t(f, { s: r.label, x: W.x + 12, y, max: W.w - 24, fonts: FONTS, what: 'switch row' });
        if (i === v.sw.cursor) t(f, { s: '{CURSOR}', x: W.x + 2, y, what: 'cursor' });
      });
      if (v.sw.up) t(f, { s: '{UP}', x: W.x + W.w - 10, y: W.y, what: 'arrow' });
      if (v.sw.down) t(f, { s: '{DOWN}', x: W.x + W.w - 10, y: W.y + (n - 1) * W.pitch, what: 'arrow' });
    }
  }
  const PAINT = Object.freeze({ welcome: drawWelcome, wait: drawWait, list: drawList, grid: drawGrid, pics: drawPics, card: drawCard });
  function draw(f, view) {
    const v = view.trainer; if (!v) return;
    (PAINT[v.kind] || drawWait)(f, v, view);
  }
  return {
    render(f, view) { draw(f, view); },
    measure(f, view) { probe = []; try { draw(f, view); return probe; } finally { probe = null; } },
    /** (tests) how many pictures were decoded so far. */
    cacheSize: () => pics.size,
  };
}
