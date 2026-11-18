// pokemonarena/js/builder_screen.js -- draws THE TEAM BUILDER (builder_hub.js view -> pixels) from the ROM: the shared FURNITURE every builder screen is drawn with, and the registry of the
// screens' painters (one module per screen family: builder_screen_home.js, builder_screen_team.js, builder_screen_mon.js, builder_screen_pick.js, builder_screen_moves.js,
// builder_screen_stats.js, builder_screen_io.js).
//
// Pure ES module (browser + Node): no DOM, no timers. hub_screen.js gives this module the frame `f` (the terrain picture already on it) and its drawing helpers `h`
// (pokemonarena/INAPP.md "The app interface"); the text entry and the dialog layer are drawn by hub_screen.js over what is drawn here.
//
// EVERY PIXEL IS THE ROM'S: the party-menu teal behind every builder screen, the ROM's 6 px window ring, the ROM's party slot panel (slots, chips), the ROM fonts and their cursor / arrow
// glyphs, the ROM message box, the ROM's party icons, front sprites, trainer heads, type badges, category icons and the HP-bar tiles a stat bar is built from (editor_art.js createArtKit,
// decoded lazily: only what a frame shows). The only things that are not ROM art are the plain white interiors the ROM's windows have. No picture is made in code, nothing is recoloured,
// and a sprite is never scaled.
//
// THE FURNITURE (K, handed to every painter)
//   K.t(f, { s, x, y, max, font | fonts, align, fg, sh, what })   ONE TEXT: the first font of `fonts` that fits `max` pixels (cut to fit only as the last resort), drawn left / right / centre
//                              aligned. EVERY text of the builder goes through it, and measure(view) hands the tests each one with the room it had: that is how "every text fits its window" is
//                              checked at the extremes (the longest species, ability and item names of this ROM, a 10-character trainer, a 16-character team)
//   K.bg / K.strip / K.chip   the teal, the title strip (title, chips, the autosave tag), one chip (the ROM party panel: normal, selected, or grey when it has nothing to do)
//   K.list / K.box / K.popup / K.message   a list window with its rows (label, value between the arrows, a small tag), a plain ROM window, the pop-up menu, the message box and its "more" arrow
//   K.icon / K.sprite / K.badge / K.head / K.cat / K.bar   ROM art by id, drawn where asked; an id the ROM has no picture for draws nothing (and says so to the caller)
// A PAINTER   (K) => { kind: (f, b, view) => void }: `b` is view.builder. To add a screen family: write its painters and add them to PAINTER_SETS below. A tab of the Pokemon screen registers
//   under 'tab:<layout>'.

import { createArtKit } from './editor_art.js';
import { BG, listH } from './builder_geom.js';
import { PAINTERS as HOME } from './builder_screen_home.js';
import { PAINTERS as TEAM } from './builder_screen_team.js';
import { PAINTERS as MON } from './builder_screen_mon.js';
import { PAINTERS as PICK } from './builder_screen_pick.js';
import { PAINTERS as MOVES } from './builder_screen_moves.js';
import { PAINTERS as STATS } from './builder_screen_stats.js';
import { PAINTERS as IO } from './builder_screen_io.js';

/** The painters of every screen family. A LATER STAGE ADDS ITS SET HERE (and its family in builder_hub.js). */
export const PAINTER_SETS = Object.freeze([HOME, TEAM, MON, PICK, MOVES, STATS, IO]);
export const FONTS = Object.freeze(['normal', 'narrow', 'smallNarrow']);

export function createScreen(ui, h, sets = PAINTER_SETS) {
  const TEXT = ui.TEXT, COL = ui.COL, R = ui.R;
  let art = null;
  const kit = () => (art || (art = createArtKit(ui.rom)));          // (made with the first builder frame, not with the hub)
  let probe = null;                                                // while measure() runs: every text drawn, with the room it had

  /* ---------------------------------------------------------------------------------------- text */
  function t(f, o) {
    const s = ui.safeText(String(o.s === undefined || o.s === null ? '' : o.s));
    const fonts = o.fonts || [o.font || 'normal'];
    const font = o.max ? h.fitFont(s, o.max, fonts) : fonts[0];
    const full = h.width(font, s);
    let shown = s, px = full;
    if (o.max && full > o.max) { shown = h.fitText(font, s, o.max); px = h.width(font, shown); }
    const x = Math.floor(o.align === 'right' ? o.x - px : o.align === 'centre' ? o.x - px / 2 : o.x);
    h.text(f, font, shown, x, o.y, o.fg, o.sh);
    if (probe) probe.push({ what: o.what || 'text', s, font, px: full, max: o.max === undefined ? null : o.max, cut: shown !== s, x, y: o.y, right: x + px });
    return { font, px, x };
  }
  const onTeal = { fg: TEXT.white, sh: TEXT.dark };

  /* ---------------------------------------------------------------------------------------- pieces */
  const bg = (f) => f.rect(0, 0, h.SCREEN_W, h.SCREEN_H, ui.partyArt().bg);
  const box = (f, r) => ui.drawWindow(f, r.x, r.y, r.w, r.h);
  /** One chip: { label, x, y, w, h, on?, off? }. on = highlighted (the ROM's selected panel), off = nothing to do there (the ROM's grey panel). */
  function chip(f, c) {
    ui.panel(f, c.x, c.y, c.w, c.h, c.off ? 'grey' : c.on ? 'sel' : 'normal', true);
    t(f, { s: c.label, x: c.x + c.w / 2, y: c.y + (c.h >= 16 ? 0 : -1), align: 'centre', max: c.w - 6, fonts: FONTS, fg: c.off ? COL.line : TEXT.dark, sh: TEXT.shadow, what: 'chip ' + c.label });
  }
  /** The title strip: the title (as wide as the room left of the chips and the tag), the chips, the autosave / read-only tag. o.titleMax overrides the title's room. */
  function strip(f, b, o = {}) {
    const S = BG.strip, chips = b.chips || [];
    const tagW = b.tag ? h.width('small', b.tag.text) : 0;
    const edge = chips.length ? Math.min(...chips.map((c) => c.x)) - 4 : b.tag ? S.tag.right - tagW - 6 : 236;
    t(f, { s: b.title, x: S.title.x, y: S.title.y, max: o.titleMax || edge - S.title.x, fonts: FONTS, ...onTeal, what: 'title' });
    for (const c of chips) chip(f, c);
    if (b.tag) t(f, { s: b.tag.text, x: S.tag.right, y: S.tag.y, align: 'right', font: 'small', max: S.tag.w, fg: b.tag.bad ? TEXT.orange : TEXT.white, sh: TEXT.dark, what: 'tag' });
  }
  /** A label and its value sharing a row between `left` and `right`: the label keeps the normal font while the value fits beside it in ANY font; a choice row under the cursor shows the ROM's arrows. */
  function pair(f, row, left, right, y, on, fg) {
    const choice = row.kind === 'choice', arrows = choice && on && !row.disabled, val = String(row.value), reserve = choice ? 20 : 0, room = right - left;
    let lf = FONTS[FONTS.length - 1], vf = lf;
    search: for (const a of FONTS) for (const c of FONTS) if (h.width(a, row.label) + 4 + h.width(c, ui.safeText(val)) + reserve <= room) { lf = a; vf = c; break search; }
    const lw = t(f, { s: row.label, x: left, y, font: lf, max: room, fg, what: 'row label' }).px;
    const vr = arrows ? right - 10 : right;
    const v = t(f, { s: val, x: vr, y, align: 'right', font: vf, max: room - lw - 4 - reserve, fg: row.bad ? COL.red : fg, what: 'row value' });
    if (arrows) { t(f, { s: '{RIGHT}', x: right - 9, y, what: 'arrow' }); t(f, { s: '{LEFT}', x: vr - v.px - 10, y, what: 'arrow' }); }
  }
  /**
   * A list window (g: builder_geom.js BG.list / BG.wide / BG.mon.list) with the rows of a list view (builder_parts.js createList view()). o.h: the window's height when it holds more than the
   * rows (the move picker's foot line); o.tagMax: the room a row's small tag may take (default 40).
   */
  function list(f, g, lv, o = {}) {
    ui.drawWindow(f, g.x, g.y, g.w, o.h || listH(g));
    const left = g.x + 11, right = g.x + g.w - 12;                    // (the last 10 px are the lane of the "more above / below" arrows)
    lv.rows.forEach((row, i) => {
      const y = g.y + i * g.pitch, on = i === lv.cursor, fg = row.disabled || row.dim ? COL.line : TEXT.dark;
      if (row.value !== undefined) pair(f, row, left, right, y, on, fg);
      else {
        let room = right - left;
        if (row.tag) { const w = t(f, { s: row.tag, x: right, y, align: 'right', font: 'small', max: o.tagMax || 40, fg: row.bad ? COL.red : COL.line, what: 'row tag' }).px; room -= w + 4; }
        t(f, { s: row.label, x: left, y, max: room, fonts: FONTS, fg, what: 'row' });
      }
      if (on) t(f, { s: '{CURSOR}', x: g.x + 2, y, what: 'cursor' });
    });
    // "more above / below": the ROM's arrows in the lane at the right of the first / last row (left out on a row that is showing its own left / right arrows: two arrows side by side read as one control)
    const busy = (i) => { const r = lv.rows[i]; return !!r && i === lv.cursor && r.kind === 'choice' && r.value !== undefined && !r.disabled; };
    if (lv.up && !busy(0)) t(f, { s: '{UP}', x: g.x + g.w - 10, y: g.y, what: 'arrow' });
    if (lv.down && !busy(g.rows - 1)) t(f, { s: '{DOWN}', x: g.x + g.w - 10, y: g.y + (g.rows - 1) * g.pitch, what: 'arrow' });
  }
  /** The pop-up menu (builder_parts.js createPopupSlot view()): a ROM window, an optional title line, the rows that are shown and the cursor; a menu that scrolls has the ROM's arrows in a lane at its right. */
  function popup(f, p) {
    ui.drawWindow(f, p.x, p.y, p.w, p.h);
    const left = p.x + BG.popup.lead, right = p.x + p.w - 4 - (p.lane ? BG.popup.lane : 0), k = p.title ? 1 : 0;
    if (p.title) t(f, { s: p.title, x: p.x + 4, y: p.y, max: p.w - 8, fonts: FONTS, fg: COL.blue, what: 'popup title' });
    p.rows.forEach((row, i) => {
      const y = p.y + (i + k) * p.pitch, on = i === p.cursor, fg = row.disabled ? COL.line : TEXT.dark;
      if (row.value !== undefined) pair(f, row, left, right, y, on, fg);
      else t(f, { s: row.label, x: left, y, max: right - left, fonts: FONTS, fg, what: 'popup row' });
      if (on) t(f, { s: '{CURSOR}', x: p.x + 2, y, what: 'cursor' });
    });
    if (p.up) t(f, { s: '{UP}', x: p.x + p.w - 10, y: p.y + k * p.pitch, what: 'arrow' });
    if (p.down) t(f, { s: '{DOWN}', x: p.x + p.w - 10, y: p.y + (k + p.rows.length - 1) * p.pitch, what: 'arrow' });
  }
  /** The ROM message box with the view's two lines, and the ROM's down arrow at its foot while the text goes on over the page. */
  function message(f, view) {
    const b = view.builder, lines = view.msg || ['', ''];
    h.drawMessage(f, lines);
    if (probe) lines.forEach((ln) => probe.push({ what: 'msg', s: ln, font: 'normal', px: ln ? h.width('normal', ln) : 0, max: R.msg.w - 4 - (b && b.pages > 1 ? 12 : 0), cut: false, x: R.msg.x + 2, y: R.msg.y, right: R.msg.x + 2 + (ln ? h.width('normal', ln) : 0) }));
    if (b && b.more) t(f, { s: '{DOWN}', x: R.msg.x + R.msg.w - 12, y: R.msg.y + 17, what: 'arrow' });
  }

  /* ---------------------------------------------------------------------------------------- ROM art by id */
  /** Blit an { width, height, rgba } picture at (x, y), keeping to `clip` ({ x, y, w, h }) when given. */
  function blit(f, img, x, y, clip) {
    if (!clip) { f.blit(img.width, img.height, img.rgba, x, y); return; }
    const x0 = Math.max(0, clip.x - x), y0 = Math.max(0, clip.y - y), x1 = Math.min(img.width, clip.x + clip.w - x), y1 = Math.min(img.height, clip.y + clip.h - y);
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, hh = y1 - y0, out = new Uint8Array(w * hh * 4);
    for (let yy = 0; yy < hh; yy++) out.set(img.rgba.subarray(((y0 + yy) * img.width + x0) * 4, ((y0 + yy) * img.width + x0 + w) * 4), yy * w * 4);
    f.blit(w, hh, out, x + x0, y + y0);
  }
  /** The ROM's 32x32 party icon of a species. -> false when the ROM has no picture for that id. */
  function icon(f, species, shiny, x, y, clip) { const im = kit().monIcon(species, { shiny: !!shiny, frame: 0 }); if (!im) return false; blit(f, im, x, y, clip); return true; }
  /** The ROM's 64x64 front sprite (o: { shiny, female, frame }). -> false when the ROM has none. */
  function sprite(f, species, o, x, y) { const sp = kit().frontSprite(species, { shiny: !!(o && o.shiny), female: !!(o && o.female) }); if (!sp) return false; blit(f, sp.frames[((o && o.frame) | 0) % sp.frames.length], x, y); return true; }
  /** The ROM's 32x16 type badge. */
  function badge(f, typeId, x, y) { blit(f, kit().typeBadge(typeId), x, y); }
  /** Up to two type badges side by side, centred in `w` pixels from x. */
  function badges(f, types, x, y, w) { const n = Math.min(2, types.length), x0 = x + Math.floor((w - n * 32) / 2); for (let i = 0; i < n; i++) badge(f, types[i], x0 + i * 32, y); }
  /** A trainer's portrait: one of the ROM's 52 trainer heads (avatar { kind: 'preset', id }) or a Pokemon's front sprite ({ kind: 'mon', id }). -> false when there is none to draw. */
  function head(f, avatar, x, y) {
    if (!avatar) return false;
    if (avatar.kind === 'mon') return sprite(f, avatar.id, {}, x, y);
    blit(f, kit().trainerHead(avatar.id | 0), x, y); return true;
  }
  /** The ROM's 16x16 category icon of a move (0 physical, 1 special, 2 status). */
  function cat(f, category, x, y) { blit(f, kit().categoryIcon(category | 0), x, y); }
  /** A stat bar built from the ROM's HP-bar tiles (editor_art.js statBar: green, yellow or red by how full it is), `tiles` tiles of 8 px wide. */
  function bar(f, value, max, x, y, tiles) { blit(f, kit().statBar(value, max, tiles || 8), x, y); }
  /** `s` as lines no wider than `px` in `font` (h.wrap: words kept whole). */
  const wrap = (font, s, px, maxLines) => h.wrap(font, ui.safeText(String(s)), px, maxLines);

  const K = { ui, h, TEXT, COL, G: BG, FONTS, onTeal, t, bg, box, chip, strip, pair, list, popup, message, blit, icon, sprite, badge, badges, head, cat, bar, wrap, art: kit };
  const painters = {};
  for (const set of sets) Object.assign(painters, set(K));
  K.painters = painters;

  /** The screen every builder path shows until its profile is read (or when storage could not be opened): the teal, the title, one window with a word. */
  function wait(f, b) {
    strip(f, b);
    const r = { x: 60, y: 44, w: 120, h: 16 };
    box(f, r);
    t(f, { s: (b.lines && b.lines[0]) || 'LOADING...', x: 120, y: r.y, align: 'centre', max: r.w - 4, fonts: FONTS, what: 'wait' });
  }
  function draw(f, view) {
    const b = view.builder; if (!b) return;
    bg(f);
    const p = painters[b.kind];
    if (b.kind === 'wait' || !p) wait(f, b); else p(f, b, view);
    message(f, view);
    if (b.popup) popup(f, b.popup);
  }
  return {
    /** Draw a builder view onto `f`. */
    render(f, view) { draw(f, view); },
    /** Draw `view` onto `f` and say what was written: [{ what, s, font, px, max, cut, x, y, right }] for EVERY text (px: its full width; max: the room it was given, null = none; cut: it did not fit). */
    measure(f, view) { probe = []; try { draw(f, view); return probe; } finally { probe = null; } },
    /** The art kit (editor_art.js), for the tests: what was decoded so far (cacheSize()). */
    art: kit, kinds: () => Object.keys(painters),
  };
}
