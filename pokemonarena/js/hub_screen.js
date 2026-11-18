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
// WHO DRAWS WHAT: the hub's own screens and the Tower's are drawn here (tower_screen.js); an APP's view (view.app = its id) is drawn by that app's renderer (hub_app_screens.js lists them), on the
// frame this module has laid the terrain on, with the helpers `h` this module gives it. Over ANY of them: a text entry when the view carries `entry` (textentry_screen.js), then the dialog layer
// when it carries `dialog` (the ROM message box, and the ROM window for the options).
//
// WHAT IS NOT THE GAME'S OWN: the layout (which window goes where) is this module's composition of ROM pieces, as the party / preview /
// result screens of scene.js are; the words on the menu are written by this site (the ROM has no such menu), set in the ROM font.

import { GEOM, SCREEN_W, SCREEN_H, menuPitch } from './hub_model.js';
import { createPageDrawer } from './page_draw.js';
import { createTowerScreen } from './tower_screen.js';
import { createTextEntryScreen } from './textentry_screen.js';
import { APP_SCREENS } from './hub_app_screens.js';

// (every coordinate is taken as a WHOLE pixel: a half pixel -- the centre of an odd-width chip -- would otherwise address the buffer two channels off and smear the colours)
class Frame {
  constructor() { this.width = SCREEN_W; this.height = SCREEN_H; this.rgba = new Uint8Array(SCREEN_W * SCREEN_H * 4); }
  rect(x0, y0, w, h, c) {
    x0 = Math.floor(x0); y0 = Math.floor(y0); w = Math.floor(w); h = Math.floor(h);
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) {
      const o = (y * this.width + x) * 4; this.rgba[o] = c[0]; this.rgba[o + 1] = c[1]; this.rgba[o + 2] = c[2]; this.rgba[o + 3] = 255;
    }
  }
  blit(sw, sh, src, dx, dy) {
    dx = Math.floor(dx); dy = Math.floor(dy);
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
    dx = Math.floor(dx); dy = Math.floor(dy);
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

  // (a menu may carry its own place: { x, y, w } on the menu, as hub_menu.js's view does; without them it stands where the hub's menus do)
  function drawMenu(f, menu) {
    const g = { x: Number.isFinite(menu.x) ? menu.x : GEOM.menu.x, y: Number.isFinite(menu.y) ? menu.y : GEOM.menu.y, w: Number.isFinite(menu.w) ? menu.w : GEOM.menu.w }, n = menu.rows.length, pitch = menuPitch(n), h = n * pitch + (n > 7 ? 2 : 0);          // ST1: eight rows at 12 px need two more pixels under the last one, or its letters touch the window's ring
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
    // a menu longer than the room scrolls (the main menu): an arrow shows where there is more
    if (menu.up) text(f, 'normal', '{UP}', g.x + g.w - 9, g.y + 1, TEXT.dark);
    if (menu.down) text(f, 'normal', '{DOWN}', g.x + g.w - 9, g.y + (n - 1) * pitch + 1, TEXT.dark);
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

  // THE TOWER's screens (tower_screen.js) are drawn with the same pieces: they borrow this module's text, message box and menu
  const tower = createTowerScreen(ui, { text, textRight, textCentre, width, drawMenu, drawMessage, fitFont: (s, px, fonts) => ui.fitFont(s, px, fonts) });

  // THE APPS' screens and the text entry get the same pieces and a few more (pokemonarena/INAPP.md "The app interface" lists them)
  const fitText = (font, s, maxPx) => { let t = ui.safeText(String(s)); while (t.length > 0 && width(font, t) > maxPx) t = t.slice(0, -1); return t; };
  const chip = (f, r, label, on) => { ui.panel(f, r.x, r.y, r.w, r.h, on ? 'sel' : 'normal', true); textCentre(f, pickFont(label, r.w - 6), label, r.x + r.w / 2, r.y, TEXT.dark, TEXT.shadow); };
  const helpers = Object.freeze({ text, textRight, textCentre, width, fitFont: (s, px, fonts) => ui.fitFont(s, px, fonts), fitText, wrap: tower.wrap, drawMenu, drawMessage, chip, SCREEN_W, SCREEN_H });
  const entry = createTextEntryScreen(ui, helpers);
  const apps = {};
  for (const id of Object.keys(APP_SCREENS)) apps[id] = APP_SCREENS[id](ui, helpers);

  // THE DIALOG LAYER (hub_dialog.js view): the ROM message box with the page's two lines, the ROM "more" arrow while there is another page, and one ROM window with the options and the menu cursor
  const dialogFont = (s, maxPx) => pickFont(s, maxPx);
  function drawDialog(f, d) {
    f.blit(240, 48, boxRGBA, 0, 112);
    f.rect(R.msg.x, R.msg.y, R.msg.w, R.msg.h, TEXT.white);
    d.lines.forEach((ln, i) => { if (ln) text(f, dialogFont(ln, R.msg.w - 4), ln, R.msg.x + 2, R.msg.y + 1 + i * 16); });
    if (d.more) text(f, 'normal', '{DOWN}', R.msg.x + R.msg.w - 12, R.msg.y + 17, TEXT.dark);
    if (d.choice) {
      const c = d.choice;
      ui.drawWindow(f, c.x, c.y, c.w, c.h);
      c.options.forEach((o, i) => { const y = c.y + i * c.pitch; text(f, dialogFont(o, c.w - 14), o, c.x + 12, y + 1); if (i === c.cursor) text(f, 'normal', '{CURSOR}', c.x + 2, y + 1, TEXT.dark); });
    }
  }

  return {
    GEOM, tower, apps, entry, helpers,
    render(view) {
      const f = new Frame();
      f.rgba.set(ui.env(Math.max(0, Math.min(22, view.env | 0))).rgba);
      const isTower = typeof view.screen === 'string' && view.screen.startsWith('tower');
      const isApp = typeof view.app === 'string';
      if (view.screen !== 'record' && !isTower && !isApp) mascot(f, view.mascot, view.tick | 0);
      if (isApp) {
        const a = Object.prototype.hasOwnProperty.call(apps, view.app) ? apps[view.app] : null;
        if (a) a.render(f, view);
        else { drawMessage(f, ['This screen has no picture yet.', 'B goes back.']); }          // an app with a model and no renderer listed in hub_app_screens.js
      } else if (isTower && view.tower) {
        tower.render(f, view);
      } else if (view.screen === 'record' && view.record) {
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
      if (view.entry) entry.draw(f, view.entry, view.tick | 0);          // a text entry covers the screen that opened it ...
      if (view.dialog) drawDialog(f, view.dialog);                       // ... and a dialog sits over everything
      return { width: SCREEN_W, height: SCREEN_H, rgba: f.rgba };
    },
    /** A new empty frame (240x160, every pixel transparent black) with rect / blit / blitRoles: what render() draws on, for a test that draws one app's screen by itself. */
    frame: () => new Frame(),
    /** How wide `s` is in the message font, in pixels, and how wide a message line may be: the Tower wraps the long texts of its lists by these (tower_hub.js wrapLines), so a word is never cut. */
    measure: (s) => width('normal', ui.safeText(String(s))),
    msgPx: R.msg.w - 4,
    /** ... and in ANY ROM font ('normal' | 'narrow' | 'small' | 'smallNarrow' ...): what createHubModel's measureFont option takes, so an app's ctx.measure and the dialog layer measure with the real font. */
    measureFont: (font, s) => width(font, ui.safeText(String(s))),
    /** The widest line any message / about page of this view needs, in pixels (the tests check every one fits its window). */
    widths(view) {
      const out = [];
      (view.msg || []).forEach((ln) => out.push({ what: 'msg', font: 'normal', px: ln ? width('normal', ui.safeText(ln)) : 0, max: R.msg.w - 4 }));
      if (view.about) view.about.lines.forEach((ln, i) => out.push({ what: 'about', font: i ? 'small' : 'normal', px: width(i ? 'small' : 'normal', ui.safeText(ln)), max: GEOM.about.w - 4 }));
      if (view.dialog) {
        view.dialog.lines.forEach((ln) => { const font = dialogFont(ln, R.msg.w - 4); out.push({ what: 'dialog', font, px: ln ? width(font, ln) : 0, max: R.msg.w - 4 }); });
        if (view.dialog.choice) view.dialog.choice.options.forEach((o) => { const font = dialogFont(o, view.dialog.choice.w - 14); out.push({ what: 'dialog option', font, px: width(font, o), max: view.dialog.choice.w - 14 }); });
      }
      if (view.entry) { const L = entry.layout(view.entry); out.push({ what: 'entry field', font: L.field.font, px: L.field.px, max: L.field.max }, { what: 'entry title', font: L.title.font, px: L.title.px, max: L.title.max }, { what: 'entry note', font: L.note.font, px: L.note.px, max: L.note.max }); }
      return out;
    },
  };
}
