// pokemonarena/js/builder_screen_pick.js -- the painters of THE TEAM BUILDER's PICKERS (builder_pick.js): the species picker and the held-item picker.
//
// Pure ES module (browser + Node): no DOM, no timers. Drawn with builder_screen.js's furniture `K` (its header lists it); every pixel is the ROM's.
//   species   the strip: what is listed and how many, FILTER and the two page chips (grey when there is no page that way). The list: a name and its Pokedex number on each row, a row the
//             rules leave out in the ROM's grey. Beside it the highlighted Pokemon's ROM front sprite over its type badges. ONLY THAT ONE SPRITE is decoded per frame (and the art kit keeps
//             the last 24), so the list answers a key at once however long it is
//   item      the strip and one wide list (the ROM has no item pictures this site decodes: the names are set in the ROM font, the ROM's description is in the message box)

export const PAINTERS = (K) => {
  const { G, t } = K;
  return {
    species(f, b) {
      const S = G.side;
      K.strip(f, b); K.list(f, G.list, b.list); K.box(f, { x: S.x, y: S.y, w: S.w, h: S.h });
      if (!b.side) return;
      if (!K.sprite(f, b.side.species, { frame: b.frame }, S.x + 8, S.y)) t(f, { s: '?', x: S.x + 36, y: S.y + 24, what: 'no sprite' });
      K.badges(f, b.side.types, S.x + 8, S.y + 68, 64);
    },
    item(f, b) { K.strip(f, b); K.list(f, G.wide, b.list); },
  };
};
