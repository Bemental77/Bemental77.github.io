// pokemonarena/js/center_screen.js -- draws THE TRAINER CENTER (center_hub.js view -> pixels) from the ROM. A STUB: replaced, with center_hub.js and center_ctl.js, by the Trainer Center work.
//
// Pure ES module (browser + Node): no DOM, no timers. Everything is drawn the way the rest of the hub is: the ROM's window ring and menu cursor, the ROM fonts, the ROM message box. hub_screen.js has
// already laid the terrain picture down and gives this module the frame `f` and its own drawing helpers `h` (pokemonarena/INAPP.md "The app interface" lists them).

import { CGEOM } from './center_hub.js';

export function createScreen(ui, h) {
  const TEXT = ui.TEXT;
  return {
    /** Draw a 'center' view onto `f`. */
    render(f, view) {
      const c = view.center; if (!c) return;
      h.drawMessage(f, view.msg);
      h.drawMenu(f, view.menu);
      const P = CGEOM.panel;
      ui.drawWindow(f, P.x, P.y, P.w, P.h);
      h.textCentre(f, h.fitFont(c.title, P.w - 4, ['normal', 'narrow', 'smallNarrow']), c.title, P.x + P.w / 2, P.y + 1, TEXT.dark);
      c.lines.forEach((ln, i) => { if (ln) h.text(f, h.fitFont(ln, P.w - 6, ['small', 'smallNarrow']), ln, P.x + 3, P.y + 19 + i * 12); });
    },
  };
}
