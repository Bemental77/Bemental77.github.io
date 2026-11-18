// pokemonarena/js/builder_screen.js -- draws THE TEAM BUILDER (builder_hub.js view -> pixels) from the ROM. A STUB: replaced, with builder_hub.js and builder_ctl.js, by the Team Builder work.
//
// Pure ES module (browser + Node): no DOM, no timers. Everything is drawn the way the rest of the hub is: the ROM's window ring and menu cursor, the ROM fonts, the ROM message box. hub_screen.js has
// already laid the terrain picture down and gives this module the frame `f` and its own drawing helpers `h` (pokemonarena/INAPP.md "The app interface" lists them). The text entry (view.entry) is
// NOT drawn here: hub_screen.js draws it over this picture.

import { BGEOM } from './builder_hub.js';

export function createScreen(ui, h) {
  const TEXT = ui.TEXT;
  return {
    /** Draw a 'builder' view onto `f`. */
    render(f, view) {
      const b = view.builder; if (!b) return;
      h.drawMessage(f, view.msg);
      h.drawMenu(f, view.menu);
      const P = BGEOM.panel;
      ui.drawWindow(f, P.x, P.y, P.w, P.h);
      h.textCentre(f, h.fitFont(b.title, P.w - 4, ['normal', 'narrow', 'smallNarrow']), b.title, P.x + P.w / 2, P.y + 1, TEXT.dark);
      b.lines.forEach((ln, i) => { const font = h.fitFont(ln, P.w - 6, ['small', 'smallNarrow']); h.text(f, font, h.fitText(font, ln, P.w - 6), P.x + 3, P.y + 19 + i * 12); });
    },
  };
}
