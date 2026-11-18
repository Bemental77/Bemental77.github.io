// pokemonarena/js/center_screen.js -- draws THE TRAINER CENTER (center_hub.js view -> pixels). EVERY PIXEL IS THE ROM'S: the room is the ROM's own Pokemon Center map (world_rom.js
// renderView: what lies under the people and what lies over them), the people are the ROM's overworld trainer sprites in their own palettes, the bubbles are the ROM's emote icons, the
// windows, the menu cursor, the party-menu chips and every letter are the ROM's (battle_ui.js, through `ui` and the shell's helpers `h`). There is no drawing code that paints art here, no
// colour table and no picture: the only colours named are the ROM text colours `ui.TEXT`, used for letters. THE PLATE A NAME IS WRITTEN ON IS THE ROM'S TOO: the party-menu chip (`ui.panel`),
// the plain one for the others and the selected one for the player. Nothing in the room is a rectangle filled by this file.
//
// ONE FRAME: the map's lower layers; the nurse, her Pokemon and every trainer, top to bottom (a 16 x 32 sprite stands with its feet on its cell: its top is one cell above); the map's top
// layer (the plants' leaves, the things on the counter); then the line that says what B does, the emote bubbles over the heads, and LAST what must always be readable: the names (a plate
// at each trainer's feet: the ROM's party-menu chip, the selected chip for me); then the mode's window (the menu, the look picker, the emote picker, WHO'S HERE) with the ROM message box.
//
// NO NAME LIES ON ANOTHER NAME (layoutTags). A plate is wider than a cell, so two trainers side by side (which is how one walks up to somebody) would write their names over each other.
// The plates of one row are laid side by side instead, each still under its own trainer; when a row is too crowded for that, the trainers farthest from the player go without a plate
// (their names are in WHO'S HERE and in the question A opens). A plate never lies on the line that says what B does either.
//
// Pure ES module (browser + Node): no DOM, no timers. createScreen is called once, the first time the Center is drawn: it decodes the room and keeps it; a trainer's pictures are decoded the
// first time they are needed and kept.

import { centerWorld } from './center_world.js';
import { CGEOM, WORDS } from './center_hub.js';
import { CELL } from './center_room.js';

/** A name tag: the font, how far below the top of the trainer's cell the plate begins (it laps over the soles: a name must not lie on the trainer in the next row), the plate's padding, the room between two
 *  plates, and how many of a plate's pixels across must stay under its own trainer's cell when it is moved aside. */
export const TAG = Object.freeze({ font: 'smallNarrow', dy: 14, padX: 2, padY: 1, maxPx: 60, gap: 1, hold: 6 });

/**
 * WHERE THE NAME PLATES GO, so that none lies on another (pure). tags: [{ x, y, w, h, cx, pri }]: each plate where it would be if it were alone (x, y), the middle column of its trainer's cell
 * (cx), and its rank (pri: 0 = the player; the smaller, the nearer to the player). width: the picture's. -> the same plates in the same order, each { ...tag, x, shown }.
 *   - plates whose rows of pixels meet are one BAND (a row of trainers; two trainers a step apart);
 *   - in a band the plates stand side by side in the order their trainers stand, TAG.gap apart, inside the picture;
 *   - A PLATE STAYS UNDER ITS OWN TRAINER: at least TAG.hold of its pixels across lie under the trainer's own cell. That gives every plate a stretch it may begin in. Where the plates of a
 *     run of neighbours cannot all begin in theirs (the row is too crowded there), the one with the highest rank number in that run (the trainer farthest from the player) is left out
 *     (shown: false) and the band is laid out again. The player's own plate is never the one left out;
 *   - within what that allows, the plates stand where they would on average like to (blocks of touching plates, each block where its plates' own places put it: least shift for all).
 */
export function layoutTags(tags, width) {
  const out = tags.map((t) => ({ ...t, shown: true }));
  // where each plate of a row would like to begin: blocks of touching plates, a block standing where its plates on average want it
  function wishes(live) {
    const blocks = [];
    const place = (b) => { b.pos = Math.round(b.sum / b.items.length); return b; };
    for (const t of live) {
      let b = place({ items: [t], w: t.w, sum: t.x0 });          // sum: over its plates, where each wants the BLOCK to begin
      while (blocks.length && blocks[blocks.length - 1].pos + blocks[blocks.length - 1].w + TAG.gap > b.pos) {
        const p = blocks.pop();
        b = place({ items: p.items.concat(b.items), w: p.w + TAG.gap + b.w, sum: p.sum + b.sum - b.items.length * (p.w + TAG.gap) });
      }
      blocks.push(b);
    }
    const want = [];
    for (const b of blocks) { let x = b.pos; for (const t of b.items) { want.push(x); x += t.w + TAG.gap; } }
    return want;
  }
  function settle(band) {
    let live = band.slice();
    while (live.length) {
      live.sort((a, b) => a.cx - b.cx || a.pri - b.pri);
      const n = live.length, lo = [], hi = [], first = [], last = [];
      for (const t of live) { const hold = Math.min(TAG.hold, t.w); lo.push(Math.max(0, t.cx - CELL / 2 + hold - t.w)); hi.push(Math.min(width - t.w, t.cx + CELL / 2 - hold)); }
      // the earliest each plate can begin, left to right. One that cannot begin early enough to stay under its trainer: the run of plates pushing it is too crowded
      let fail = -1, run = 0;
      for (let i = 0; i < n; i++) {
        const after = i ? first[i - 1] + live[i - 1].w + TAG.gap : -Infinity;
        if (after <= lo[i]) run = i;                                // (nothing pushes this plate: a crowd, if there is one, begins with it)
        first.push(Math.max(lo[i], after));
        if (first[i] > hi[i]) { fail = i; break; }
      }
      if (fail >= 0) {
        let worst = live[run];
        for (let i = run; i <= fail; i++) if (live[i].pri > worst.pri) worst = live[i];
        worst.shown = false; worst.x = worst.x0;
        live = live.filter((t) => t !== worst);
        continue;
      }
      for (let i = n - 1; i >= 0; i--) last[i] = Math.min(hi[i], i < n - 1 ? last[i + 1] - live[i].w - TAG.gap : Infinity);          // ... and the latest, right to left
      const want = wishes(live);
      let prev = -Infinity;
      for (let i = 0; i < n; i++) { const x = Math.max(Math.min(Math.max(want[i], first[i]), last[i]), prev); live[i].x = x; prev = x + live[i].w + TAG.gap; }
      return;
    }
  }
  for (const t of out) t.x0 = t.x;
  let band = [], bottom = -Infinity;
  for (const t of out.slice().sort((a, b) => a.y - b.y)) {
    if (band.length && t.y >= bottom) { settle(band); band = []; bottom = -Infinity; }
    band.push(t); bottom = Math.max(bottom, t.y + t.h);
  }
  settle(band);
  for (const t of out) delete t.x0;
  return out;
}
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

  /** Where a trainer's name would go if it were alone: { x, y, w, h, cx, text, font, bm, top } (the plate, the middle of the trainer's cell, the text's bitmap and its first inked row). */
  function tagOf(p) {
    const text = h.fitText(TAG.font, p.name, TAG.maxPx), g = glyphs(TAG.font, text);
    const w = g.bm.width + 2 * TAG.padX, hh = g.ink + 2 * TAG.padY, cx = p.px + CELL / 2;
    const x = Math.max(0, Math.min(h.SCREEN_W - w, cx - Math.floor(w / 2)));
    let y = Math.min(h.SCREEN_H - hh, p.py + TAG.dy);
    // not on the line that says what B does: a plate that could reach it (the bottom row, towards the right corner) sits just above it
    if (y + hh > CGEOM.hint.y && cx + CELL / 2 - Math.min(TAG.hold, w) + w > CGEOM.hint.x) y = CGEOM.hint.y - hh;
    return { x, y, w, h: hh, cx, text, font: TAG.font, bm: g.bm, top: g.top };
  }
  /** The name plates of a view, in the order of its people: [{ id, mine, x, y, w, h, tx, ty, bm, shown }] (layoutTags: none lies on another; shown: false = left out of a crowded row). */
  function platesOf(c) {
    const me = c.people.find((q) => q.kind === 'me') || null;
    const raw = c.people.map((p, i) => ({ ...tagOf(p), id: p.id, mine: p.kind === 'me', pri: p.kind === 'me' ? 0 : me ? 1 + Math.abs(p.px - me.px) + Math.abs(p.py - me.py) : 1 + i }));
    return layoutTags(raw, h.SCREEN_W).map((t) => ({ ...t, tx: t.x + TAG.padX, ty: t.y + TAG.padY - t.top }));
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
    // names LAST, so that a name always reads (a bubble never covers one): the others first, mine on top. The plate is the ROM's party-menu chip (the selected chip is mine)
    const plates = platesOf(c).filter((t) => t.shown);
    for (const t of plates.filter((q) => !q.mine).concat(plates.filter((q) => q.mine))) {
      ui.panel(f, t.x, t.y, t.w, t.h, t.mine ? 'sel' : 'normal', true);
      f.blitRoles(t.bm, t.tx, t.ty, TEXT.dark, null);
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
    /** For the tests: every text of this view with the room it has, [{ what, font, px, max }], and the name plates [{ id, x, y, w, h, shown }] in the order of the view's people. */
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
    tags: (view) => (view.center ? platesOf(view.center).map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, shown: t.shown })) : []),
    /** What the room is made of, for the tests: the map picture's two layers and the room the ROM gave. */
    room, picture: pic,
  };
}
