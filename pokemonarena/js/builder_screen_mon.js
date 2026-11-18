// pokemonarena/js/builder_screen_mon.js -- the painters of THE TEAM BUILDER's POKEMON family (builder_mon.js): the Pokemon screen and its tabs.
//
// Pure ES module (browser + Node): no DOM, no timers. Drawn with builder_screen.js's furniture `K` (its header lists it); every pixel is the ROM's.
//   mon         the strip: the Pokemon's name, the tab chips (the open tab is the ROM's selected panel), the autosave tag. Then the open tab's painter: K.painters['tab:' + b.layout]
//   tab:build   on the left, straight on the teal as in the ROM's own summary: the ROM front sprite (its two frames alternate: b.frame), the type badges, "No. / Lv" in the small font;
//               on the right the list of fields
//   tab:note    the same left column, and a window with a few plain lines (a tab that only has something to say)
//   tab:moves   builder_screen_moves.js;   tab:stats   builder_screen_stats.js   (each as wide as the picture: no left column)
// A NEW TAB registers its painter as 'tab:<its layout>' (here, or in a painter set of its own) and draws what it likes below the strip; K.painters.monLeft draws the left column for a tab
// that wants it.

export const PAINTERS = (K) => {
  const { G, t, TEXT } = K;
  const M = G.mon;
  function left(f, b) {
    const m = b.mon;
    if (!m.known || !K.sprite(f, m.species, { shiny: m.shiny, female: m.female, frame: b.frame }, M.sprite.x, M.sprite.y)) t(f, { s: '?', x: M.sprite.x + 28, y: M.sprite.y + 24, ...K.onTeal, what: 'no sprite' });
    K.badges(f, m.types, M.badges.x, M.badges.y, 64);
    t(f, { s: (m.dex ? '{NO}' + m.dex + ' ' : '') + '{LV}' + m.level, x: M.info.x + M.info.w / 2, y: M.info.y, align: 'centre', max: M.info.w, fonts: ['small', 'smallNarrow'], ...K.onTeal, what: 'mon info' });
  }
  return {
    monLeft: left,
    mon(f, b, view) {
      t(f, { s: b.title, x: M.name.x, y: M.name.y, max: M.name.w, fonts: K.FONTS, ...K.onTeal, what: 'title' });
      b.tabs.forEach((c) => K.chip(f, { ...c, on: c.id === b.tab }));
      if (b.tag) t(f, { s: b.tag.text, x: G.strip.tag.right, y: G.strip.tag.y, align: 'right', font: 'small', max: G.strip.tag.w, fg: b.tag.bad ? TEXT.orange : TEXT.white, sh: TEXT.dark, what: 'tag' });
      const p = K.painters['tab:' + b.layout];
      if (p) p(f, b, view);
    },
    'tab:build'(f, b) { left(f, b); K.list(f, M.list, b.list); },
    'tab:note'(f, b) {
      left(f, b);
      K.box(f, M.note);
      (b.lines || []).forEach((ln, i) => t(f, { s: ln, x: M.note.x + 4, y: M.note.y + 2 + (i ? 6 : 0) + i * 12, max: M.note.w - 8, fonts: i ? ['small', 'smallNarrow'] : K.FONTS, what: 'note line' }));
    },
  };
};
