// pokemonarena/js/builder_screen_moves.js -- the painters of THE TEAM BUILDER's MOVES family (builder_moves.js): the Pokemon screen's MOVES tab and the move picker.
//
// Pure ES module (browser + Node): no DOM, no timers. Drawn with builder_screen.js's furniture `K` (its header lists it); every pixel is the ROM's.
//   tab:moves   one ROM window as wide as the picture: four rows 16 px apart, each the move's ROM type badge (32x16), its name and the ROM's category icon (16x16); an empty slot says
//               "+ ADD A MOVE"; then UNDO and REDO as the list scrolls. Under the rows, in the small font, the highlighted move's POWER, ACC and PP
//   move        the strip (what is listed and how many, FILTER and the two page chips); six rows, each a move's name and, small and grey, where it comes from (Lv 12 TM24); a move that
//               cannot be taken is in the ROM's grey. In the same window a foot line for the highlighted move: its numbers on the left, its type badge and category icon on the right
// ONLY the art of the rows in sight is decoded (the type badges and the three category icons are kept by the art kit).

export const PAINTERS = (K) => {
  const { G, t, TEXT, COL } = K;
  const SMALL = ['small', 'smallNarrow'];
  return {
    'tab:moves'(f, b) {
      const M = G.moves, g = M.list, lv = b.list;
      K.box(f, M.win);
      lv.rows.forEach((row, i) => {
        const y = g.y + i * g.pitch, fg = row.disabled || row.dim ? COL.line : TEXT.dark;
        if (row.type !== undefined) {
          K.badge(f, row.type, M.badge, y);
          t(f, { s: row.label, x: M.name, y, max: M.icon - 3 - M.name, fonts: K.FONTS, fg, what: 'move name' });
          K.cat(f, row.category, M.icon, y);
        } else {
          const x = row.slot !== undefined ? M.name : M.badge;          // (a slot's words stand where a move's name would; UNDO and REDO at the left, like any list row)
          t(f, { s: row.label, x, y, max: M.icon + 16 - x, fonts: K.FONTS, fg, what: 'move row' });
        }
        if (i === lv.cursor) t(f, { s: '{CURSOR}', x: g.x + 2, y, what: 'cursor' });
      });
      if (lv.up) t(f, { s: '{UP}', x: g.x + g.w - 10, y: g.y, what: 'arrow' });
      if (lv.down) t(f, { s: '{DOWN}', x: g.x + g.w - 10, y: g.y + (g.rows - 1) * g.pitch, what: 'arrow' });
      if (b.info) t(f, { s: 'POWER ' + b.info.power + '   ACC ' + b.info.accuracy + '   PP ' + b.info.pp, x: M.info.x, y: M.info.y, max: M.info.w, fonts: SMALL, fg: COL.blue, what: 'move info' });
    },
    move(f, b) {
      const P = G.mpick, F = P.foot;
      K.strip(f, b);
      K.list(f, P.list, b.list, { h: P.win.h, tagMax: 60 });
      if (!b.info) return;
      t(f, { s: 'PWR ' + b.info.power + '  ACC ' + b.info.accuracy + '  PP ' + b.info.pp, x: F.x, y: F.y, max: F.w, fonts: SMALL, fg: COL.blue, what: 'move info' });
      K.badge(f, b.info.type, F.badge, F.y);
      K.cat(f, b.info.category, F.icon, F.y);
    },
  };
};
