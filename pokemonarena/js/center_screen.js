// pokemonarena/js/center_screen.js -- draws THE TRAINER CENTER (center_hub.js view -> pixels). EVERY PIXEL IS THE ROM'S: the room is the ROM's own Pokemon Center map (world_rom.js
// renderView: what lies under the people and what lies over them), the people are the ROM's overworld trainer sprites in their own palettes, the bubbles are the ROM's emote icons, the
// windows, the menu cursor, the party-menu chips and every letter are the ROM's (battle_ui.js, through `ui` and the shell's helpers `h`). There is no drawing code that paints art here, no
// colour table and no picture: the only colours named are the ROM text colours `ui.TEXT`, used for letters and for the plate a name is written on.
//
// ONE FRAME: the map's lower layers; the nurse, her Pokemon and every trainer, top to bottom (a 16 x 32 sprite stands with its feet on its cell: its top is one cell above); the map's top
// layer (the plants' leaves, the things on the counter); then the line that says what B does, the emote bubbles over the heads, and LAST what must always be readable: the names (a plate
// at each trainer's feet: dark on white for the others, white on dark for me); then the mode's window (the menu, the look picker, the emote picker, WHO'S HERE) with the ROM message box.
//
// Pure ES module (browser + Node): no DOM, no timers. createScreen is called once, the first time the Center is drawn: it decodes the room and keeps it; a trainer's pictures are decoded the
// first time they are needed and kept.

import { centerWorld } from './center_world.js';
import { CGEOM, WORDS } from './center_hub.js';
import { CELL } from './center_room.js';

/** A name tag: the font, how far below the top of the trainer's cell the plate begins (it laps over the soles: a name must not lie on the trainer in the next row), the plate's padding. */
export const TAG = Object.freeze({ font: 'smallNarrow', dy: 14, padX: 2, padY: 1, maxPx: 60 });
/** Where a bubble sits over a 16 x 32 trainer: this far above the top of the sprite's cell pair (it overlaps the sprite's empty top rows). */
export const BUBBLE_UP = 13;

export function createScreen(ui, h) {
  const TEXT = ui.TEXT, A = ui.assets;
  const { world, room } = centerWorld(ui.rom);
  const map = world.center;
  const pic = world.renderView(map, 0, 0, h.SCREEN_W, h.SCREEN_H);
  // the map's own people that are drawn: the nurse and the Pokemon beside her (INAPP.md, Wave 2 decision 8)
  const npcs = world.mapSprites(map).filter((s) => s.sprite && room.npcs.some((n) => n.gfx === s.gfx && n.x === s.x && n.y === s.y))
    .map((s) => ({ x: s.px, y: s.py, w: s.sprite.width, h: s.sprite.height, rgba: s.sprite.rgba, feet: (s.y + 1) * CELL, order: 0 }));
  const pictures = new Map();
  const walker = (gfx, d, step) => { const k = gfx + ':' + d + ':' + step; let v = pictures.get(k); if (!v) { v = world.ow.walker(gfx, d, step); pictures.set(k, v); } return v; };
  const emotes = world.emotes;
  const icon = (e, f) => { const m = emotes[e]; return m ? m.frames[f % m.frames.length] : null; };
  // a text's bitmap and the rows its letters really use (a font's cell is taller than its letters: the plate is as tall as the ink, not as the cell)
  const inked = new Map();
  function glyphs(font, s) {
    const k = font + '|' + s; let g = inked.get(k);
    if (g) return g;
    const bm = A.drawText(font, ui.safeText(s));
    let top = bm.height, bottom = -1;
    for (let y = 0; y < bm.height; y++) for (let x = 0; x < bm.width; x++) if (bm.pixels[y * bm.width + x] === 1) { if (y < top) top = y; if (y > bottom) bottom = y; }
    if (bottom < 0) { top = 0; bottom = 0; }
    g = { bm, top, ink: bottom - top + 1 };
    if (inked.size > 400) inked.clear();
    inked.set(k, g);
    return g;
  }

  /** Where a trainer's name goes: { x, y, w, h, tx, ty, text, font } (the plate, and the text's top-left corner). */
  function tagOf(p) {
    const text = h.fitText(TAG.font, p.name, TAG.maxPx), g = glyphs(TAG.font, text);
    const w = g.bm.width + 2 * TAG.padX, hh = g.ink + 2 * TAG.padY;
    const x = Math.max(0, Math.min(h.SCREEN_W - w, p.px + CELL / 2 - Math.floor(w / 2))), y = Math.min(h.SCREEN_H - hh, p.py + TAG.dy);
    return { x, y, w, h: hh, tx: x + TAG.padX, ty: y + TAG.padY - g.top, text, font: TAG.font, bm: g.bm };
  }

  function drawRoom(f, c) {
    f.blit(h.SCREEN_W, h.SCREEN_H, pic.under, 0, 0);
    const list = npcs.slice();
    for (const p of c.people) { const s = walker(p.gfx, p.d, p.step); list.push({ x: p.px, y: p.py + CELL - s.height, w: s.width, h: s.height, rgba: s.rgba, feet: p.py + CELL, order: 1 }); }
    list.sort((a, b) => a.feet - b.feet || a.order - b.order);          // (the model already gave the trainers top to bottom: the sort is stable)
    for (const s of list) f.blit(s.w, s.h, s.rgba, s.x, s.y);
    f.blit(h.SCREEN_W, h.SCREEN_H, pic.over, 0, 0);
    h.textRight(f, 'small', c.hint, h.SCREEN_W - 2, CGEOM.hint.y + 2, TEXT.white, TEXT.dark);
    for (const p of c.people) { if (!p.emote) continue; const r = icon(p.emote.e, p.emote.f); if (r) f.blit(16, 16, r, p.px, p.py - CELL - BUBBLE_UP); }
    // names LAST, so that a name always reads (a bubble never covers one): the others first, mine on top
    for (const p of c.people.filter((q) => q.kind !== 'me').concat(c.people.filter((q) => q.kind === 'me'))) {
      const t = tagOf(p), mine = p.kind === 'me';
      f.rect(t.x, t.y, t.w, t.h, mine ? TEXT.dark : TEXT.white);
      f.blitRoles(t.bm, t.tx, t.ty, mine ? TEXT.white : TEXT.dark, null);
    }
  }

  const cellOf = (G, i) => ({ x: G.x + (i % G.cols) * G.cw, y: G.y + G.top + Math.floor(i / G.cols) * G.ch });
  function drawLook(f, L) {
    const G = CGEOM.look;
    ui.drawWindow(f, G.x, G.y, G.w, G.h);
    h.text(f, 'normal', 'YOUR LOOK', G.x + 2, G.y + 1);
    h.text(f, 'normal', '{LEFT}', G.x + G.w - 70, G.y + 1);
    h.textCentre(f, 'normal', (L.page + 1) + '/' + L.pages, G.x + G.w - 38, G.y + 1);
    h.text(f, 'normal', '{RIGHT}', G.x + G.w - 14, G.y + 1);
    L.items.forEach((gfx, i) => {
      const r = cellOf(G, i), on = i === L.cursor;
      if (on) ui.panel(f, r.x + 2, r.y + 2, G.cw - 4, G.ch - 4, 'sel', true);
      const s = walker(gfx, 'down', on ? L.step : 0);
      f.blit(s.width, s.height, s.rgba, r.x + (G.cw - s.width) / 2, r.y + (G.ch - s.height) / 2);
    });
    h.drawMessage(f, WORDS.lookMsg);
  }
  function drawEmote(f, E) {
    const G = CGEOM.emote;
    ui.drawWindow(f, G.x, G.y, G.w, G.h);
    h.text(f, 'normal', 'EMOTE', G.x + 2, G.y + 1);
    for (let i = 0; i < E.count; i++) {
      const r = cellOf(G, i), on = i === E.cursor;
      if (on) ui.panel(f, r.x + 1, r.y + 1, G.cw - 2, G.ch - 2, 'sel', true);
      const rgba = icon(i, on ? E.f : 0);
      if (rgba) f.blit(16, 16, rgba, r.x + (G.cw - 16) / 2, r.y + (G.ch - 16) / 2);
    }
    h.drawMessage(f, WORDS.emoteMsg);
  }
  const WHO = Object.freeze({ name: 12, nameMax: 60, rec: 140, recMax: 66, doingMax: 62, arrow: 14 });          // (the last 14 px of a row are the scroll arrows')
  function drawWho(f, W) {
    const G = CGEOM.who;
    ui.drawWindow(f, G.x, G.y, G.w, G.h);
    h.text(f, 'normal', "WHO'S HERE", G.x + 2, G.y + 1);
    h.textRight(f, 'normal', String(W.total), G.x + G.w - WHO.arrow, G.y + 1);
    W.rows.forEach((r, i) => {
      const y = G.y + G.top + i * G.pitch;
      if (i === W.cursor) h.text(f, 'normal', '{CURSOR}', G.x + 2, y + 1);
      h.text(f, h.fitFont(r.name, WHO.nameMax, ['normal', 'narrow', 'smallNarrow']), r.name, G.x + WHO.name, y + 1);
      if (r.rec) h.textRight(f, h.fitFont(r.rec, WHO.recMax, ['normal', 'narrow', 'smallNarrow']), r.rec, G.x + WHO.rec, y + 1);
      h.textRight(f, h.fitFont(r.doing, WHO.doingMax, ['small', 'smallNarrow']), r.doing, G.x + G.w - WHO.arrow, y + 3);
    });
    if (W.up) h.text(f, 'normal', '{UP}', G.x + G.w - 10, G.y + 1);
    if (W.down) h.text(f, 'normal', '{DOWN}', G.x + G.w - 10, G.y + G.h - 15);
    h.drawMessage(f, W.total ? [WORDS.whoMsg, ''] : [WORDS.whoNone, 'B: back']);
  }

  return {
    /** Draw a 'center' view onto `f`. */
    render(f, view) {
      const c = view.center; if (!c) return;
      drawRoom(f, c);
      if (c.menu) h.drawMenu(f, c.menu);
      if (c.look) drawLook(f, c.look);
      if (c.emote) drawEmote(f, c.emote);
      if (c.who) drawWho(f, c.who);
    },
    /** For the tests: every text of this view with the room it has, [{ what, font, px, max }], and the name plates [{ id, x, y, w, h }]. */
    widths(view) {
      const c = view.center, out = [];
      if (!c) return out;
      const add = (what, font, s, max) => out.push({ what, font, px: h.width(font, s), max });
      add('hint', 'small', c.hint, CGEOM.hint.w - 2);
      for (const p of c.people) { const t = tagOf(p); out.push({ what: 'tag ' + p.name, font: t.font, px: t.w, max: TAG.maxPx + 2 * TAG.padX }); }
      if (c.menu) for (const r of c.menu.rows) add('menu ' + r.label, 'normal', r.label, c.menu.w - 16);
      if (c.look) { add('look title', 'normal', 'YOUR LOOK', CGEOM.look.w - 80); add('look page', 'normal', (c.look.page + 1) + '/' + c.look.pages, 44); for (const ln of WORDS.lookMsg) add('look msg', 'normal', ln, ui.R.msg.w - 4); }
      if (c.emote) for (const ln of WORDS.emoteMsg) add('emote msg', 'normal', ln, ui.R.msg.w - 4);
      if (c.who) {
        add('who title', 'normal', "WHO'S HERE", 100); add('who msg', 'normal', c.who.total ? WORDS.whoMsg : WORDS.whoNone, ui.R.msg.w - 4);
        for (const r of c.who.rows) { add('who name ' + r.name, h.fitFont(r.name, WHO.nameMax, ['normal', 'narrow', 'smallNarrow']), r.name, WHO.nameMax); if (r.rec) add('who rec ' + r.rec, h.fitFont(r.rec, WHO.recMax, ['normal', 'narrow', 'smallNarrow']), r.rec, WHO.recMax); add('who doing ' + r.doing, h.fitFont(r.doing, WHO.doingMax, ['small', 'smallNarrow']), r.doing, WHO.doingMax); }
      }
      return out;
    },
    tags: (view) => (view.center ? view.center.people.map((p) => { const t = tagOf(p); return { id: p.id, x: t.x, y: t.y, w: t.w, h: t.h }; }) : []),
    /** What the room is made of, for the tests: the map picture's two layers and the room the ROM gave. */
    room, picture: pic,
  };
}
