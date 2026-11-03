// pokemonarena/js/hub_screen.js -- draws the HUB from the ROM: view (hub_model.js) -> 240x160 RGBA.
//
// Pure ES module (browser + Node): no DOM, no timers. Every pixel comes from the SoulGold v1.1.1 ROM through the same renderer the battle
// screen uses (battle_ui.js createBattleUi): the terrain picture behind the menu, the Pokemon's own front sprite, the ROM's window ring,
// the ROM fonts and cursor glyph, the ROM battle message box at the bottom. Nothing is drawn with a rectangle in the place of art; the
// only rectangles are the plain white window interiors the ROM's windows have.
//
//   const ui = createBattleUi(romBytes);
//   const screen = createHubScreen(ui);
//   const frame = screen.render(hub.view());          // { width: 240, height: 160, rgba }
//
// WHAT IS NOT THE GAME'S OWN: the layout (which window goes where) is this module's composition of ROM pieces, as the party / preview /
// result screens of scene.js are; the words on the menu are written by this site (the ROM has no such menu), set in the ROM font.

import { GEOM, SCREEN_W, SCREEN_H, menuPitch } from './hub_model.js';
import { createPageDrawer } from './page_draw.js';

class Frame {
  constructor() { this.width = SCREEN_W; this.height = SCREEN_H; this.rgba = new Uint8Array(SCREEN_W * SCREEN_H * 4); }
  rect(x0, y0, w, h, c) {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) {
      const o = (y * this.width + x) * 4; this.rgba[o] = c[0]; this.rgba[o + 1] = c[1]; this.rgba[o + 2] = c[2]; this.rgba[o + 3] = 255;
    }
  }
  blit(sw, sh, src, dx, dy) {
    for (let y = 0; y < sh; y++) {
      const Y = dy + y; if (Y < 0 || Y >= this.height) continue;
      for (let x = 0; x < sw; x++) {
        const X = dx + x; if (X < 0 || X >= this.width) continue;
        const s = (y * sw + x) * 4; if (src[s + 3] === 0) continue;
        const o = (Y * this.width + X) * 4; this.rgba[o] = src[s]; this.rgba[o + 1] = src[s + 1]; this.rgba[o + 2] = src[s + 2]; this.rgba[o + 3] = 255;
      }
    }
  }
  blitRoles(bm, dx, dy, fg, shadow) {
    for (let y = 0; y < bm.height; y++) {
      const Y = dy + y; if (Y < 0 || Y >= this.height) continue;
      for (let x = 0; x < bm.width; x++) {
        const v = bm.pixels[y * bm.width + x]; if (!v) continue;
        const X = dx + x; if (X < 0 || X >= this.width) continue;
        const c = v === 1 ? fg : shadow; if (!c) continue;
        const o = (Y * this.width + X) * 4; this.rgba[o] = c[0]; this.rgba[o + 1] = c[1]; this.rgba[o + 2] = c[2]; this.rgba[o + 3] = 255;
      }
    }
  }
}

export function createHubScreen(ui) {
  const TEXT = ui.TEXT, COL = ui.COL, A = ui.assets;
  const R = ui.R;
  const textbox = A.get('textbox.message');
  const boxRGBA = A.rgba(textbox, { transparent0: false });
  const text = (f, font, s, x, y, fg, sh) => f.blitRoles(A.drawText(font, ui.safeText(s)), x, y, fg || TEXT.dark, sh === undefined ? TEXT.shadow : sh);
  const width = (font, s) => ui.measure(font, s);
  const textRight = (f, font, s, rx, y, fg, sh) => text(f, font, s, rx - width(font, s), y, fg, sh);
  const textCentre = (f, font, s, cx, y, fg, sh) => text(f, font, s, cx - Math.floor(width(font, s) / 2), y, fg, sh);
  const pickFont = (s, maxPx) => ui.fitFont(s, maxPx, ['normal', 'narrow', 'smallNarrow']);

  function mascot(f, m, tick) {
    if (!m) return;
    let sp;
    try { sp = ui.sprite(m.species, 'foe', { shiny: !!m.shiny, female: m.gender === 'F', frame: (tick >> 5) & 1 }); } catch (_e) { return; }
    const c = GEOM.mascot;
    f.blit(64, 64, sp.rgba, c.cx - 32, c.cy + sp.yOffset - sp.elevation - 32);
  }

  function drawMenu(f, menu) {
    const g = GEOM.menu, n = menu.rows.length, pitch = menuPitch(n), h = n * pitch + (n > 7 ? 2 : 0);          // ST1: eight rows at 12 px need two more pixels under the last one, or its letters touch the window's ring
    ui.drawWindow(f, g.x, g.y, g.w, h);
    menu.rows.forEach((row, i) => {
      const y = g.y + i * pitch, on = i === menu.cursor;
      const fg = row.disabled ? COL.line : TEXT.dark;
      if (row.kind === 'choice') {
        const room = g.w - 12 - 6;
        const lw = width('normal', row.label);
        const showArrows = on;
        const val = ui.safeText(String(row.value));
        const vmax = room - lw - 8 - (showArrows ? 20 : 0);
        const vf = ui.fitFont(val, vmax, ['normal', 'narrow', 'smallNarrow']);
        let shown = val;
        while (shown.length > 1 && width(vf, shown) > vmax) shown = shown.slice(0, -1);
        text(f, 'normal', row.label, g.x + 12, y + 1, fg);
        const vr = g.x + g.w - 4;
        if (showArrows) {
          text(f, 'normal', '{RIGHT}', vr - 8, y + 1, TEXT.dark);
          textRight(f, vf, shown, vr - 11, y + 1, fg);
          text(f, 'normal', '{LEFT}', vr - 12 - width(vf, shown) - 9, y + 1, TEXT.dark);
        } else textRight(f, vf, shown, vr, y + 1, fg);
      } else {
        const font = pickFont(row.label, g.w - 16);
        text(f, font, row.label, g.x + 12, y + 1, fg);
      }
      if (on) text(f, 'normal', '{CURSOR}', g.x + 2, y + 1, TEXT.dark);
    });
  }

  function drawMessage(f, lines) {
    f.blit(240, 48, boxRGBA, 0, 112);
    f.rect(R.msg.x, R.msg.y, R.msg.w, R.msg.h, TEXT.white);
    (lines || []).forEach((ln, i) => { if (ln) text(f, 'normal', ln, R.msg.x + 2, R.msg.y + 1 + i * 16); });
  }

  // ST1: the RECORD screen: the party-menu teal behind, the trainer and the page's name in the title row, one ROM window holding the page, three buttons (YES / NO while RESET RECORD asks)
  const pages = createPageDrawer(ui);
  function drawRecord(f, rc, tick) {
    const G = GEOM.record, bob = ((tick | 0) >> 4) & 1;
    f.rect(0, 0, SCREEN_W, SCREEN_H, ui.partyArt().bg);
    if (rc.trainer) {
      const multi = rc.trainer.count > 1;
      const label = multi ? '{LEFT} ' + rc.trainer.name + ' {RIGHT}' : rc.trainer.name;
      text(f, 'normal', label, G.trainer.x + (multi && rc.focus === 'trainer' ? 10 : 0), G.title.y, TEXT.white, TEXT.dark);
      if (multi && rc.focus === 'trainer') text(f, 'normal', '{CURSOR}', G.trainer.x, G.title.y, TEXT.white, TEXT.dark);
    }
    textRight(f, 'normal', rc.page.title + ' ' + (rc.index + 1) + '/' + rc.count, 232, G.title.y, TEXT.white, TEXT.dark);
    pages.drawWindowPage(f, rc.page, G.win, { bob });
    if (rc.button) { const b = rc.button; ui.panel(f, b.x, b.y, b.w, b.h, !b.enabled ? 'grey' : rc.hover === 'reset' ? 'sel' : 'normal', true); textCentre(f, 'normal', b.label, b.x + b.w / 2, b.y, b.enabled ? TEXT.dark : COL.line, TEXT.shadow); }
    if (rc.confirm) {
      [['YES', G.chips[0], 0], ['NO', G.chips[2], 1]].forEach(([label, c, k]) => { ui.panel(f, c.x, c.y, c.w, c.h, rc.confirm.cursor === k ? 'sel' : 'normal', true); textCentre(f, 'normal', label, c.x + c.w / 2, c.y, TEXT.dark, TEXT.shadow); });
      return;
    }
    const labels = { prev: '{LEFT} PREV', back: 'BACK', next: 'NEXT {RIGHT}' };
    G.chips.forEach((c) => {
      const dead = (c.id === 'prev' && !rc.canPrev) || (c.id === 'next' && !rc.canNext);
      ui.panel(f, c.x, c.y, c.w, c.h, dead ? 'grey' : rc.hover === c.id ? 'sel' : 'normal', true);
      textCentre(f, 'normal', labels[c.id], c.x + c.w / 2, c.y, dead ? COL.line : TEXT.dark, TEXT.shadow);
    });
  }

  function drawAbout(f, a) {
    const g = GEOM.about;
    ui.drawWindow(f, g.x, g.y, g.w, g.h);
    a.lines.forEach((ln, i) => {
      if (i === 0) text(f, 'normal', ln, g.x + 2, g.y + 1);
      else text(f, 'small', ln, g.x + 2, g.y + 18 + (i - 1) * g.pitch);
    });
    if (!a.last) text(f, 'normal', '{DOWN}', g.x + g.w - 12, g.y + g.h - 15);
  }

  return {
    GEOM,
    render(view) {
      const f = new Frame();
      f.rgba.set(ui.env(Math.max(0, Math.min(22, view.env | 0))).rgba);
      if (view.screen !== 'record') mascot(f, view.mascot, view.tick | 0);
      if (view.screen === 'record' && view.record) {
        drawRecord(f, view.record, view.tick);
      } else if (view.screen === 'about' && view.about) {
        drawMessage(f, ['Page ' + (view.about.page + 1) + ' of ' + view.about.pages + '.', view.about.last ? 'A or B goes back.' : 'A turns the page. B goes back.']);
        drawAbout(f, view.about);
      } else {
        drawMessage(f, view.msg);
        if (view.title) {
          const t = GEOM.title;
          ui.drawWindow(f, t.x, t.y, t.w, t.h);
          textCentre(f, 'normal', 'POK{E}MON ARENA', t.x + t.w / 2, t.y + 1);
        }
        if (view.menu) drawMenu(f, view.menu);
      }
      return { width: SCREEN_W, height: SCREEN_H, rgba: f.rgba };
    },
    /** The widest line any message / about page of this view needs, in pixels (the tests check every one fits its window). */
    widths(view) {
      const out = [];
      (view.msg || []).forEach((ln) => out.push({ what: 'msg', font: 'normal', px: ln ? width('normal', ui.safeText(ln)) : 0, max: R.msg.w - 4 }));
      if (view.about) view.about.lines.forEach((ln, i) => out.push({ what: 'about', font: i ? 'small' : 'normal', px: width(i ? 'small' : 'normal', ui.safeText(ln)), max: GEOM.about.w - 4 }));
      return out;
    },
  };
}
