// pokemonarena/js/tower_screen.js -- draws the TOWER's hub screens (tower_hub.js view -> pixels) from the ROM: view -> the 240x160 frame hub_screen.js gives it.
//
// Pure ES module (browser + Node): no DOM, no timers. Everything is drawn the way the rest of the hub is: the ROM's window ring and menu cursor, the ROM fonts, the ROM party-menu teal, the ROM chips, the ROM
// message box. The only things that are not ROM art are plain filled rectangles: the white window interiors the ROM's windows have, and the selected ball's coloured outline.
//
// THE POKE BALLS ON THE OFFER SCREEN are the ROM's own ball sprites (anim_mon.js ballGfx, the 17-entry ball table the battle's send-out already draws): green = ball 7, blue = 9, purple = 4, gold = 13 (tower_config.js
// BALL_STYLE; the colours were measured on the ROM). They are drawn at 2x, closed when idle and OPEN (frame 1, lifted a few pixels) when highlighted. What is NOT reproduced is the starter-selection scene's own
// art (its table, its panel, its cursor): that scene's graphics were not found in the ROM tables this site reads, so the offer screen is this module's composition of the pieces that are known.

import { TGEOM, ballCentres } from './tower_hub.js';
import { SCREEN_W, SCREEN_H } from './hub_model.js';

const hex = (c) => { const n = parseInt(String(c).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const ink = (c) => hex(c).map((v) => Math.round(v * 0.68));                  // the rarity colour darkened so that it reads on a white window
const GRADE = ['green', 'blue', 'purple', 'gold'];
const GRADE_HEX = { green: '#4caf50', blue: '#42a5f5', purple: '#ab47bc', gold: '#ffca28' };

export function createTowerScreen(ui, h) {
  const { text, textRight, textCentre, width } = h;
  const TEXT = ui.TEXT, COL = ui.COL;
  const scaled = new Map();

  /** The ROM ball sprite `index`, frame `fr`, doubled (nearest neighbour): { w: 32, h: 32, rgba }. */
  function ball2x(index, fr) {
    const key = index + ':' + fr; let b = scaled.get(key);
    if (b) return b;
    const src = ui.ballRGBA(index, fr), out = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const s = ((y >> 1) * 16 + (x >> 1)) * 4, d = (y * 32 + x) * 4; out[d] = src.rgba[s]; out[d + 1] = src.rgba[s + 1]; out[d + 2] = src.rgba[s + 2]; out[d + 3] = src.rgba[s + 3]; }
    b = { w: 32, h: 32, rgba: out }; scaled.set(key, b); return b;
  }
  /** `s` broken into lines no wider than maxPx in `font` (words kept whole where they fit). */
  function wrap(font, s, maxPx, maxLines) {
    const words = String(s).split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (const w0 of words) {
      let w = w0;
      while (width(font, w) > maxPx && w.length > 1) { let k = w.length - 1; while (k > 1 && width(font, w.slice(0, k)) > maxPx) k--; if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, k)); w = w.slice(k); }
      const t = cur ? cur + ' ' + w : w;
      if (width(font, t) <= maxPx) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (maxLines && lines.length > maxLines) { const kept = lines.slice(0, maxLines); let last = kept[maxLines - 1]; while (last.length > 1 && width(font, last + '...') > maxPx) last = last.slice(0, -1); kept[maxLines - 1] = last + '...'; return kept; }
    return lines;
  }
  const fitText = (font, s, maxPx) => { let t = String(s); while (t.length > 1 && width(font, t) > maxPx) t = t.slice(0, -1); return t; };
  const outline = (f, x, y, w, hh, c, t = 2) => { f.rect(x, y, w, t, c); f.rect(x, y + hh - t, w, t, c); f.rect(x, y, t, hh, c); f.rect(x + w - t, y, t, hh, c); };
  const chip = (f, r, label, on) => { ui.panel(f, r.x, r.y, r.w, r.h, on ? 'sel' : 'normal', true); textCentre(f, 'normal', label, r.x + r.w / 2, r.y, TEXT.dark, TEXT.shadow); };
  function drawConfirm(f, c) { chip(f, TGEOM.yes, 'YES', c.cursor === 0); chip(f, TGEOM.no, 'NO', c.cursor === 1); }

  /* ------------------------------------------------------------------------------------------ the status window (home, new run) */
  function drawPanel(f, lines) {
    const P = TGEOM.panel;
    ui.drawWindow(f, P.x, P.y, P.w, P.h);
    lines.forEach((ln, i) => { if (!ln) return; if (i === 0) textCentre(f, 'normal', ln, P.x + P.w / 2, P.y + 1, TEXT.dark); else text(f, h.fitFont(ln, P.w - 6, ['small', 'smallNarrow']), ln, P.x + 3, P.y + 19 + (i - 1) * 12); });
  }

  /* ------------------------------------------------------------------------------------------ the offer */
  function drawOffer(f, t, tick) {
    f.rect(0, 0, SCREEN_W, SCREEN_H, ui.partyArt().bg);
    text(f, 'normal', 'THE TOWER  FLOOR ' + t.floor + ' CLEARED', 8, -2, TEXT.white, TEXT.dark);
    if (t.state !== 'ready') { h.drawMessage(f, ['', '']); textCentre(f, 'normal', t.state === 'loading' ? 'LOADING...' : 'NO BUFF IS WAITING', 120, 60, TEXT.white, TEXT.dark); return; }
    h.drawMessage(f, t.msgLines);
    const n = t.balls.length, cs = ballCentres(n), cur = t.cursor, G = TGEOM;
    // the info window first, so that a lifted ball is drawn over its top edge, never under it
    ui.drawWindow(f, G.info.x, G.info.y, G.info.w, G.info.h);
    const b = cur < n ? t.balls[cur] : null;
    if (b) {
      const nm = h.fitFont(b.name, 150, ['normal', 'narrow', 'smallNarrow']);
      text(f, nm, fitText(nm, b.name, 150), G.info.x + 2, G.info.y + 1, b.curse ? COL.red : TEXT.dark);
      textRight(f, 'normal', b.rarity.toUpperCase(), G.info.x + G.info.w - 3, G.info.y + 1, ink(b.color), TEXT.shadow);
      const eff = wrap('small', b.effectText || '', G.info.w - 8, 2);
      eff.forEach((ln, i) => text(f, 'small', ln, G.info.x + 2, G.info.y + 16 + i * 10));
      let y = G.info.y + 16 + eff.length * 10 + 2;
      if (b.stacksInto) { text(f, 'small', 'YOU HOLD IT: ' + GRADE[b.stacksInto.from.tier].toUpperCase() + ' TO ' + GRADE[b.stacksInto.to.tier].toUpperCase(), G.info.x + 2, y, ink(GRADE_HEX[GRADE[b.stacksInto.to.tier]])); y += 10; }
      const sp = b.synergyProgress && b.synergyProgress[0];
      if (sp && y < G.info.y + G.info.h - 8) text(f, 'small', fitText('small', (sp.gained ? 'NEW: ' : '') + sp.name.toUpperCase() + ' ' + sp.have + '/' + sp.need, G.info.w - 8), G.info.x + 2, y, sp.gained ? COL.green : TEXT.dark);
    } else {
      text(f, 'normal', 'SKIP', G.info.x + 2, G.info.y + 1, TEXT.dark);
      text(f, 'small', 'Take nothing from this offer.', G.info.x + 2, G.info.y + 16);
      text(f, 'small', 'It will not come back.', G.info.x + 2, G.info.y + 26);
    }
    chip(f, G.skip, 'SKIP', cur === n && !t.confirm);
    cs.forEach((c, i) => {
      const bl = t.balls[i], sel = i === cur, lift = sel ? G.balls.lift : 0, sp = ball2x(bl.ball, sel ? 1 : 0);
      f.blit(32, 32, sp.rgba, c.x - 16, c.y - 16 - lift);
      if (sel) outline(f, c.x - 19, c.y - 19 - lift, 38, 38, hex(bl.color), 2);
    });
    if (t.confirm) drawConfirm(f, t.confirm);
  }

  /* ------------------------------------------------------------------------------------------ the lists */
  const LIST_ROWS = 7;
  function listWindow(f, header, rows, cursor, total, offset, paint) {
    const g = { x: 12, y: 10, w: 216, pitch: 12 }, hh = 14 + LIST_ROWS * g.pitch;
    ui.drawWindow(f, g.x, g.y, g.w, hh);
    header(f, g);
    rows.forEach((row, i) => { const y = g.y + 14 + i * g.pitch; paint(f, row, y, g, i === cursor); if (i === cursor) text(f, 'normal', '{CURSOR}', g.x + 2, y + 1, TEXT.dark); });
    if (offset > 0) text(f, 'normal', '{UP}', g.x + g.w - 12, g.y + 14);
    if (offset + rows.length < total) text(f, 'normal', '{DOWN}', g.x + g.w - 12, g.y + 14 + (LIST_ROWS - 1) * g.pitch);
  }
  function drawBuffs(f, t) {
    if (t.state !== 'ready') { h.drawMessage(f, t.msgLines); ui.drawWindow(f, 12, 10, 216, 40); text(f, 'normal', 'NO RUN IS UNDER WAY', 20, 12, TEXT.dark); text(f, 'small', 'Start one from the Tower menu.', 20, 30); return; }
    h.drawMessage(f, t.msgLines);
    listWindow(f, (fr, g) => {
      text(fr, 'normal', 'BUFFS ' + t.counts[0], g.x + 12, g.y + 1, t.tab === 0 ? TEXT.dark : COL.line);
      text(fr, 'normal', 'SYNERGIES ' + t.counts[1], g.x + 100, g.y + 1, t.tab === 1 ? TEXT.dark : COL.line);
    }, t.rows, t.cursor, t.total, t.offset, (fr, row, y, g) => {
      if (t.tab === 0) {
        const nm = h.fitFont(row.name, 150, ['normal', 'narrow', 'smallNarrow']);
        text(fr, nm, fitText(nm, row.name, 150), g.x + 12, y + 1, row.curse ? COL.red : ink(row.color));
        textRight(fr, 'small', 'POWER ' + row.power, g.x + g.w - 16, y + 2, TEXT.dark);
      } else {
        const nm = h.fitFont(row.name, 190, ['normal', 'narrow', 'smallNarrow']);
        text(fr, nm, fitText(nm, row.name, 190), g.x + 12, y + 1, TEXT.dark);
      }
    });
    if (t.detail) {
      const D = TGEOM.detail, d = t.detail;
      ui.drawWindow(f, D.x, D.y, D.w, D.h);
      text(f, 'normal', fitText('normal', d.name, 130), D.x + 2, D.y + 1, d.curse ? COL.red : TEXT.dark);
      textRight(f, 'normal', d.rarity.toUpperCase(), D.x + D.w - 3, D.y + 1, ink(d.color), TEXT.shadow);
      text(f, 'small', 'POWER ' + d.power + ' OF ' + d.cap + (d.curse ? '   A CURSE: IT COSTS YOU' : ''), D.x + 2, D.y + 16, TEXT.dark);
      wrap('small', d.text || '', D.w - 8, 6).forEach((ln, i) => text(f, 'small', ln, D.x + 2, D.y + 28 + i * 10));
    }
  }
  function drawAch(f, t) {
    h.drawMessage(f, t.msgLines);
    if (t.state !== 'ready') { ui.drawWindow(f, 12, 10, 216, 20); text(f, 'normal', 'LOADING...', 20, 12, TEXT.dark); return; }
    listWindow(f, (fr, g) => { text(fr, 'normal', 'ACHIEVEMENTS ' + t.earned + '/' + t.total, g.x + 12, g.y + 1, TEXT.dark); }, t.rows, t.cursor, t.total, t.offset, (fr, row, y, g) => {
      const got = row.at !== null, nm = h.fitFont(row.name, 150, ['normal', 'narrow', 'smallNarrow']);
      text(fr, nm, fitText(nm, row.name, 150), g.x + 12, y + 1, got ? ink(GRADE_HEX[GRADE[row.grade - 1]]) : COL.line);
      textRight(fr, 'small', got ? 'EARNED' : GRADE[row.grade - 1].toUpperCase(), g.x + g.w - 16, y + 2, got ? COL.green : COL.line);
    });
  }
  function drawLast(f, t) {
    const D = TGEOM.detail;
    h.drawMessage(f, t.msgLines);
    ui.drawWindow(f, D.x, D.y, D.w, D.h);
    const l = t.last;
    if (!l) { text(f, 'normal', 'NO CLIMB YET', D.x + 2, D.y + 1); return; }
    text(f, 'normal', l.won ? 'THE TOWER IS CLEARED!' : 'THE CLIMB ENDED', D.x + 2, D.y + 1, l.won ? COL.green : TEXT.dark);
    text(f, 'small', l.cleared + ' OF 30 FLOORS  ' + l.format + (l.livesUsed ? '  ' + l.livesUsed + ' LIFE USED' : '') + (l.skips ? '  ' + l.skips + ' SKIPPED' : ''), D.x + 2, D.y + 16);
    text(f, 'small', 'BUFFS HELD ' + l.held.length, D.x + 2, D.y + 27);
    let x = D.x + 2, y = D.y + 38;
    l.held.slice(0, 12).forEach((b) => { const nm = b.name; const w = width('small', nm) + 6; if (x + w > D.x + D.w - 4) { x = D.x + 2; y += 10; } if (y > D.y + 50) return; text(f, 'small', nm, x, y, ink(b.color)); x += w; });
    y = D.y + 62;
    text(f, 'small', l.earned.length ? 'EARNED: ' + l.earned.length : 'NO NEW ACHIEVEMENT', D.x + 2, y, l.earned.length ? COL.green : COL.line);
    wrap('small', l.earned.map((e) => e.name).join(', '), D.w - 8, 2).forEach((ln, i) => text(f, 'small', ln, D.x + 2, y + 10 + i * 10, TEXT.dark));
  }

  return {
    /** Draw a Tower view onto `f` (hub_screen.js has already laid the terrain down). */
    render(f, view) {
      const t = view.tower; if (!t) return;
      const tt = { ...t, msgLines: view.msg || ['', ''] };
      if (t.kind === 'tower' || t.kind === 'tower-new') {
        h.drawMessage(f, view.msg);
        if (view.menu) h.drawMenu(f, view.menu);
        drawPanel(f, t.panel.lines);
        if (t.confirm) drawConfirm(f, t.confirm);
      } else if (t.kind === 'tower-offer') drawOffer(f, tt, view.tick | 0);
      else {
        f.rect(0, 0, SCREEN_W, SCREEN_H, ui.partyArt().bg);
        if (t.kind === 'tower-buffs') drawBuffs(f, tt);
        else if (t.kind === 'tower-ach') drawAch(f, tt);
        else if (t.kind === 'tower-last') drawLast(f, tt);
      }
    },
    /** The widest line any Tower message needs (the tests check every one fits the message window). */
    ball2x, wrap,
  };
}
