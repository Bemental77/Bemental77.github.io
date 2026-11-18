// pokemonarena/js/builder_screen_stats.js -- the painter of THE TEAM BUILDER's STATS tab (builder_stats.js).
//
// Pure ES module (browser + Node): no DOM, no timers. Drawn with builder_screen.js's furniture `K` (its header lists it); every pixel is the ROM's.
//   tab:stats   one ROM window as wide as the picture, seven rows:
//     EDIT        the word, what is being edited between the ROM's arrows (EVS / POINTS / IVS), and at the right, small, the budget ("2 LEFT OF 510"; in the ROM's red when it is overdrawn)
//     a stat      its name; the ROM's up arrow in red where the nature raises it, the down arrow in blue where it lowers it; the battle stat; a bar built from the ROM's HP-bar tiles (its
//                 green, yellow or red strip by how full it is); the EVs (or stat points) and the IV. The number being edited is dark, the other the ROM's grey; under the cursor the edited
//                 number stands between the ROM's arrows
//     HIDDEN POWER  the words, the power, the ROM's badge of its type
//     QUICK ACTIONS, UNDO, REDO   plain rows (grey while they have nothing to do)

import { listH } from './builder_geom.js';

export const PAINTERS = (K) => {
  const { G, t, TEXT, COL } = K;
  const SMALL = ['small', 'smallNarrow'];
  return {
    'tab:stats'(f, b) {
      const S = G.stats, g = S.list, lv = b.list;
      K.box(f, { x: g.x, y: g.y, w: g.w, h: listH(g) });
      lv.rows.forEach((row, i) => {
        const y = g.y + i * g.pitch, on = i === lv.cursor, fg = row.disabled || row.dim ? COL.line : TEXT.dark;
        if (row.stat) {
          t(f, { s: row.label, x: S.label, y, max: S.arrow - S.label, what: 'stat name' });
          if (row.nat) t(f, { s: row.nat > 0 ? '{UP}' : '{DOWN}', x: S.arrow, y, fg: row.nat > 0 ? COL.red : COL.blue, what: 'arrow' });
          t(f, { s: row.value, x: S.value, y, align: 'right', max: S.value - S.arrow - 10, what: 'stat value' });
          K.bar(f, row.bar.value, row.bar.max, S.bar, y + 4);
          for (const [c, s, live] of [[S.eff, row.eff, row.live === 'eff'], [S.iv, row.iv, row.live === 'iv']]) {
            const v = t(f, { s, x: c.right, y, align: 'right', max: c.w - 20, fg: live ? TEXT.dark : COL.line, what: 'stat number' });
            if (live && on) { t(f, { s: '{RIGHT}', x: c.right + 1, y, what: 'arrow' }); t(f, { s: '{LEFT}', x: c.right - v.px - 10, y, what: 'arrow' }); }
          }
        } else if (row.id === 'edit') {
          t(f, { s: row.label, x: S.label, y, max: S.edit.value - S.label - 2, what: 'row label' });
          const v = t(f, { s: row.value, x: S.edit.value + 10, y, max: 40, what: 'row value' });
          if (on) { t(f, { s: '{LEFT}', x: S.edit.value, y, what: 'arrow' }); t(f, { s: '{RIGHT}', x: S.edit.value + 11 + v.px, y, what: 'arrow' }); }
          if (row.budget) t(f, { s: row.budget.text, x: S.budget, y, align: 'right', max: S.budget - (S.edit.value + 62), fonts: SMALL, fg: row.budget.bad ? COL.red : COL.line, what: 'budget' });
        } else if (row.id === 'hp') {
          t(f, { s: row.label, x: S.label, y, max: S.badge - 30 - S.label, fonts: K.FONTS, fg, what: 'row label' });
          t(f, { s: row.power, x: S.badge - 4, y, align: 'right', max: 20, fg, what: 'row value' });
          K.badge(f, row.type, S.badge, y);
        } else t(f, { s: row.label, x: S.label, y, max: S.budget - S.label, fonts: K.FONTS, fg, what: 'row' });
        if (on) t(f, { s: '{CURSOR}', x: g.x + 2, y, what: 'cursor' });
      });
      if (lv.up) t(f, { s: '{UP}', x: g.x + g.w - 10, y: g.y, what: 'arrow' });
      if (lv.down) t(f, { s: '{DOWN}', x: g.x + g.w - 10, y: g.y + (g.rows - 1) * g.pitch, what: 'arrow' });
    },
  };
};
