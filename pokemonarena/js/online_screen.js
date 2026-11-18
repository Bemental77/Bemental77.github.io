// pokemonarena/js/online_screen.js -- draws PLAY ONLINE (online_hub.js view -> pixels) from the ROM.
//
// Pure ES module (browser + Node): no DOM, no timers. Every pixel is the ROM's: its window ring, its fonts and its menu cursor and arrows, its message box, the front sprite of the Pokemon that
// leads the team chosen. hub_screen.js has already laid the terrain picture down and gives this module the frame `f` and its own drawing helpers `h` (pokemonarena/INAPP.md "The app interface").
// The words are written by this site (the ROM has no such menu) and set in the ROM font.
//
// THE MENU      one ROM window (OGEOM.menu / OGEOM.invite): the rows that are shown, the cursor, the ROM's up / down arrow where the list goes on. A row is a label; a CHOICE or a VALUE row
//               carries its value at the right, and the choice under the cursor stands between the ROM's left / right arrows (OGEOM.value .. the row's right end: online_hub.js hitRow halves it)
// BESIDE IT     the lead Pokemon of the team chosen (the hub's own Pokemon when the team is random), and the screen's name where the main menu has the game's
// THE INVITE    a banner across the top ("YOU'RE INVITED" / "YOUR ROOM" on the left, "ROOM <CODE>" on the right), the rows under it
// A value NEVER leaves its row: it takes the widest ROM font that fits and is cut to the room it has (rowLayout: a test measures every row of every screen with it).

import { OGEOM } from './online_hub.js';

const FONTS = Object.freeze(['normal', 'narrow', 'smallNarrow']);

export function createScreen(ui, h) {
  const TEXT = ui.TEXT, COL = ui.COL;

  /**
   * Where the parts of one row go. row: a row of the view's menu; g: { x, w } of its window; on: is the cursor on it.
   * -> { label: { font, text, x, px }, value: null | { font, text, x, px, max }, left: null | x, right: null | x } (x = absolute left edges; left / right = the choice's arrows)
   */
  function rowLayout(row, g, on) {
    const lx = g.x + OGEOM.label, edge = g.x + g.w - 4;
    if (row.value === undefined || row.value === null) {
      const font = h.fitFont(row.label, g.w - OGEOM.label - 4 - OGEOM.arrow, FONTS), text = h.fitText(font, row.label, g.w - OGEOM.label - 4 - OGEOM.arrow);
      return { label: { font, text, x: lx, px: h.width(font, text) }, value: null, left: null, right: null };
    }
    const label = { font: 'normal', text: row.label, x: lx, px: h.width('normal', row.label) };
    if (row.kind === 'choice' && on) {
      // the choice under the cursor: {LEFT} value {RIGHT}, the value centred in the room between the arrows
      const left = g.x + OGEOM.value, right = edge - OGEOM.arrow, x0 = left + 12, max = right - 2 - x0;
      const font = h.fitFont(String(row.value), max, FONTS), text = h.fitText(font, String(row.value), max), px = h.width(font, text);
      return { label, value: { font, text, x: x0 + Math.floor((max - px) / 2), px, max }, left, right };
    }
    const max = edge - OGEOM.arrow - (lx + label.px + 6);
    const font = h.fitFont(String(row.value), max, FONTS), text = h.fitText(font, String(row.value), max), px = h.width(font, text);
    return { label, value: { font, text, x: edge - OGEOM.arrow - px, px, max }, left: null, right: null };
  }

  function drawRows(f, menu) {
    const g = { x: menu.x, y: menu.y, w: menu.w }, n = menu.rows.length, pitch = menu.pitch;
    ui.drawWindow(f, g.x, g.y, g.w, n * pitch + (pitch <= 12 ? 2 : 0));          // (rows 12 px apart need two more pixels under the last one, or its letters touch the ring: the main menu's rule)
    menu.rows.forEach((row, i) => {
      const y = g.y + i * pitch + 1, on = i === menu.cursor, fg = row.disabled ? COL.line : TEXT.dark, L = rowLayout(row, g, on);
      h.text(f, L.label.font, L.label.text, L.label.x, y, fg);
      if (L.value) h.text(f, L.value.font, L.value.text, L.value.x, y, fg);
      if (L.left !== null) h.text(f, 'normal', '{LEFT}', L.left, y, TEXT.dark);
      if (L.right !== null) h.text(f, 'normal', '{RIGHT}', L.right, y, TEXT.dark);
      if (on) h.text(f, 'normal', '{CURSOR}', g.x + 2, y, TEXT.dark);
    });
    if (menu.up) h.text(f, 'normal', '{UP}', g.x + g.w - 9, g.y + 1, TEXT.dark);
    if (menu.down) h.text(f, 'normal', '{DOWN}', g.x + g.w - 9, g.y + (n - 1) * pitch + 1, TEXT.dark);
  }

  function drawLead(f, lead, cy, tick) {
    if (!lead) return;
    let sp;
    try { sp = ui.sprite(lead.species, 'foe', { shiny: !!lead.shiny, female: lead.gender === 'F', frame: (tick >> 5) & 1 }); } catch (_e) { return; }          // (a species this ROM cannot draw: no picture, the menu is whole)
    f.blit(64, 64, sp.rgba, OGEOM.lead.cx - 32, cy + sp.yOffset - sp.elevation - 32);
  }

  /** The banner of the invite screen: what the screen is on the left, the room on the right. -> { left: { font, text, px }, right: { font, text, px }, max } */
  function bannerLayout(head) {
    const b = OGEOM.banner, a = String(head[0] || ''), r = String(head[1] || '');
    const rf = h.fitFont(r, b.w - 4, FONTS), rt = h.fitText(rf, r, b.w - 4), rpx = h.width(rf, rt);
    const room = b.w - 4 - rpx - 8, lf = h.fitFont(a, room, FONTS), lt = h.fitText(lf, a, room);
    return { left: { font: lf, text: lt, px: h.width(lf, lt) }, right: { font: rf, text: rt, px: rpx }, max: b.w - 4 };
  }

  return {
    rowLayout, bannerLayout,
    /** Draw an 'online' view onto `f`. */
    render(f, view) {
      const o = view.online; if (!o || !view.menu) return;
      const invite = o.screen === 'invite';
      drawLead(f, o.lead, invite ? OGEOM.lead.cyInvite : OGEOM.lead.cy, view.tick | 0);
      h.drawMessage(f, view.msg);
      if (invite) {
        const b = OGEOM.banner, L = bannerLayout(o.head || []);
        ui.drawWindow(f, b.x, b.y, b.w, b.h);
        h.text(f, L.left.font, L.left.text, b.x + 2, b.y + 1, TEXT.dark);
        h.text(f, L.right.font, L.right.text, b.x + b.w - 2 - L.right.px, b.y + 1, TEXT.dark);
      } else {
        const t = OGEOM.title, name = String((o.head || [])[0] || ''), font = h.fitFont(name, t.w - 4, FONTS);
        ui.drawWindow(f, t.x, t.y, t.w, t.h);
        h.textCentre(f, font, h.fitText(font, name, t.w - 4), t.x + t.w / 2, t.y + 1, TEXT.dark);
      }
      drawRows(f, view.menu);
    },
  };
}
