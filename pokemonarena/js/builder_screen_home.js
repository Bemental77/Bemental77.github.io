// pokemonarena/js/builder_screen_home.js -- the painters of THE TEAM BUILDER's HOME family (builder_home.js): TRAINERS and TEAMS.
//
// Pure ES module (browser + Node): no DOM, no timers. Drawn with builder_screen.js's furniture `K` (its header lists it); every pixel is the ROM's.
//   trainers   the list; beside it the highlighted trainer's portrait (one of the ROM's 52 trainer heads) over two small lines (teams, Pokemon)
//   teams      the list (each team with OK / !n / -- at the end of its row); beside it the highlighted team's six ROM party icons, three across, over two small lines

export const PAINTERS = (K) => {
  const { G, t } = K;
  const SIDE = G.side;
  function sideLines(f, lines, bad) {
    lines.slice(0, 2).forEach((ln, i) => { if (ln) t(f, { s: ln, x: SIDE.x + 2, y: SIDE.y + 64 + i * 10, max: SIDE.w - 4, fonts: ['small', 'smallNarrow'], fg: bad && i === 1 ? K.COL.red : K.TEXT.dark, what: 'side line' }); });
  }
  return {
    trainers(f, b) {
      K.strip(f, b); K.list(f, G.list, b.list); K.box(f, { x: SIDE.x, y: SIDE.y, w: SIDE.w, h: SIDE.h });
      const s = b.side || {};
      K.head(f, s.avatar, SIDE.x + 8, SIDE.y + 1);
      sideLines(f, s.lines || [], false);
    },
    teams(f, b) {
      K.strip(f, b); K.list(f, G.list, b.list); K.box(f, { x: SIDE.x, y: SIDE.y, w: SIDE.w, h: SIDE.h });
      const s = b.side || {};
      (s.icons || []).slice(0, 6).forEach((ic, i) => {
        const x = SIDE.x + (i % 3) * 24, y = SIDE.y + 1 + Math.floor(i / 3) * 30;
        if (!K.icon(f, ic.species, ic.shiny, x, y)) t(f, { s: '?', x: x + 13, y: y + 8, what: 'no icon' });
      });
      sideLines(f, s.lines || [], s.bad);
    },
  };
};
