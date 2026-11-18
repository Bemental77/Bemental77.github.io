// pokemonarena/js/online_draw.js -- draws the ONLINE SCREENS OF THE BATTLE PAGE from the ROM: view (online_view.js onlineView + the cursor) -> pixels of the 240x160 picture.
//
// Pure ES module (browser + Node): no DOM, no timers, no state but what createScreen decodes once. It has the shape of a hub app's renderer (INAPP.md "The renderer"), so the battle page draws it
// through the hub's own shell renderer and its helpers: createHubScreen(ui, { appScreens: { online: createScreen } }).render({ app: 'online', screen: 'online', env, tick, online: view, cursor }).
// Every pixel is the ROM's: the party-menu teal behind, the ROM window ring (battle_ui.js drawWindow) with its plain interior, the ROM fonts, the ROM cursor glyph. The room code is the ROM's
// normal font at twice its size. The layout (which window goes where) is online_view.js layoutOf; the words are this site's, set in the ROM font.

import { layoutOf, sentenceLayout, OGEOM } from './online_view.js';

export const SCREEN_ID = 'online';
const TITLE_FONTS = ['normal', 'narrow', 'smallNarrow'];

export function createScreen(ui, h) {
  const TEXT = ui.TEXT, COL = ui.COL, A = ui.assets;
  const bg = ui.partyArt().bg;
  const measure = (font, s) => h.width(font, s);
  /** `s` in the first of the fonts that fits `px`, cut when none does. */
  const fit = (s, px) => { const font = h.fitFont(s, px, TITLE_FONTS); return { font, text: h.fitText(font, s, px) }; };
  /** The ROM font at twice its size (the room code, large enough to read out across a room). */
  function text2x(f, s, x, y) {
    const bm = A.drawText('normal', ui.safeText(s));
    for (let j = 0; j < bm.height; j++) for (let i = 0; i < bm.width; i++) {
      const v = bm.pixels[j * bm.width + i]; if (!v) continue;
      f.rect(x + i * 2, y + j * 2, 2, 2, v === 1 ? TEXT.dark : TEXT.shadow);
    }
    return bm.width * 2;
  }
  const white = (f, font, s, x, y) => h.text(f, font, s, x, y, TEXT.white, TEXT.dark);

  function drawRows(f, v, L, cursor) {
    const r = L.rows; if (!r) return;
    ui.drawWindow(f, r.x, r.y, r.w, r.h);
    v.rows.forEach((row, i) => {
      const y = r.y + i * r.pitch - 2, t = fit(row.label, r.w - 14);
      h.text(f, t.font, t.text, r.x + 12, y, row.disabled ? COL.line : TEXT.dark);
      if (i === cursor) h.text(f, 'normal', '{CURSOR}', r.x + 2, y, TEXT.dark);
    });
  }
  function drawSentences(f, v, L) {
    const s = L.status; if (!s || s.lines < 1) return;
    ui.drawWindow(f, s.x, s.y, s.w, s.h);
    const t = sentenceLayout(measure, v, L);
    t.lines.forEach((ln, k) => h.text(f, t.font, ln.text, s.x + 2, s.y + t.dy + k * t.pitch, ln.bad ? TEXT.red : TEXT.dark));
  }
  function drawConfirm(f, v, L, cursor) {
    const t = fit(v.heading, L.top.w);
    white(f, t.font, t.text, L.top.x, L.top.y);
    if (L.info) {
      ui.drawWindow(f, L.info.x, L.info.y, L.info.w, L.info.h);
      v.info.forEach((ln, i) => {
        const y = L.info.y + i * L.info.line, x0 = L.info.x + 2, right = L.info.x + L.info.w - 2;
        let rw = 0;
        if (ln.right) { rw = measure('normal', ln.right) + 8; h.textRight(f, 'normal', ln.right, right, y); }
        let x = x0;
        if (ln.label) { h.text(f, 'normal', ln.label, x, y, COL.line); x += measure('normal', ln.label) + 6; }
        const val = fit(ln.value, right - rw - x);
        h.text(f, val.font, val.text, x, y);
      });
    }
    drawRows(f, v, L, cursor);
    drawSentences(f, v, L);
  }
  function drawWait(f, v, L, cursor) {
    const ew = v.elapsed ? measure('normal', v.elapsed) + 8 : 0;
    const who = fit(v.who, L.top.w - ew);
    white(f, who.font, who.text, L.top.x, L.top.y);
    if (v.elapsed) { const x = L.top.x + L.top.w - measure('normal', v.elapsed); white(f, 'normal', v.elapsed, x, L.top.y); }
    // what is happening now, and the numbered steps: the ones done, the ROM cursor on the one it is at with its name, the ones to come
    const H = L.head;
    ui.drawWindow(f, H.x, H.y, H.w, H.h);
    const title = fit(v.title, H.w - 4);
    h.text(f, title.font, title.text, H.x + 2, H.y);
    let x = H.x + 2; const sy = H.steps - 2;
    v.steps.forEach((name, i) => {
      const on = i === v.at, num = String(i + 1);
      if (on) { h.text(f, 'normal', '{CURSOR}', x, sy - 1, TEXT.dark); x += 9; }
      h.text(f, 'small', num, x, sy, on ? TEXT.dark : COL.line); x += measure('small', num) + 3;
      if (on) { const t = h.fitText('small', name, H.x + H.w - 2 - x - (v.steps.length - 1 - i) * 10); h.text(f, 'small', t, x, sy, TEXT.dark); x += measure('small', t) + 6; } else x += 3;
    });
    if (L.code) {
      const c = L.code;
      ui.drawWindow(f, c.x, c.y, c.w, c.h);
      h.textCentre(f, 'small', v.codeLabel, c.x + c.w / 2, c.y - 2, COL.line);
      const w = measure('normal', v.code) * 2;
      text2x(f, v.code, Math.floor(c.x + (c.w - w) / 2), c.y + c.label - 2);
    }
    drawRows(f, v, L, cursor);
    drawSentences(f, v, L);
  }

  return {
    /** f: the shell's frame (the terrain picture is already on it); view: { online: an onlineView, cursor: the highlighted row }. A view with no online screen (a battle has the page) draws nothing. */
    render(f, view) {
      const v = view && view.online;
      if (!v || v.screen === 'hidden') return;
      f.rect(0, 0, OGEOM.W, OGEOM.H, bg);
      const L = layoutOf(v), cursor = view.cursor | 0;
      if (v.screen === 'confirm') drawConfirm(f, v, L, cursor); else drawWait(f, v, L, cursor);
    },
    /** What each line of this view measures against the room it has (the tests check every sentence the page can say fits its window): [{ what, px, max }] and the number of lines the sentence needs / has. */
    fits(v) {
      const L = layoutOf(v), out = [];
      if (v.screen === 'hidden') return { widths: out, font: 'normal', lines: 0, fits: true, room: 0 };
      const pushFit = (what, s, px) => { const t = fit(s, px); out.push({ what, font: t.font, px: measure(t.font, s), max: px }); };
      if (v.screen === 'confirm') { pushFit('heading', v.heading, L.top.w); v.rows.forEach((r) => pushFit('row ' + r.id, r.label, L.rows.w - 14)); }
      else { pushFit('who', v.who, L.top.w - (v.elapsed ? measure('normal', v.elapsed) + 8 : 0)); pushFit('title', v.title, L.head.w - 4); v.rows.forEach((r) => pushFit('row ' + r.id, r.label, L.rows.w - 14)); if (v.code) out.push({ what: 'code', font: 'normal 2x', px: measure('normal', v.code) * 2, max: L.code.w - 2 }); }
      const t = sentenceLayout(measure, v, L);
      return { widths: out, font: t.font, lines: t.lines.length, fits: t.fits, room: L.status ? L.status.lines : 0 };
    },
  };
}
