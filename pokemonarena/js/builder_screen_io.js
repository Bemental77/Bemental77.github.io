// pokemonarena/js/builder_screen_io.js -- the painters of THE TEAM BUILDER's team code, test battle (builder_io.js) and portrait picker (builder_portrait.js).
//
// Pure ES module (browser + Node): no DOM, no timers. Drawn with builder_screen.js's furniture `K` (its header lists it); every pixel is the ROM's.
//   code       the list (COPY CODE, PASTE A CODE, ENTER A CODE; or, with a code that was read, ADD AS A NEW TEAM and CANCEL); beside it the team's ROM party icons, three across, over two
//              small lines (how long the code is, LEGAL / n PROBLEMS). THE CODE ITSELF IS NEVER DRAWN: it lives on the clipboard
//   test       one wide list: FORMAT, CPU, FOE (another team's name at its full sixteen characters), START
//   portrait   three of the ROM's 64x64 trainer heads, each in a ROM window, drawn as the ROM has them (never shrunk); under each a chip with its number (the ROM's selected panel under the
//              cursor; "IN USE" on the one the trainer has)

export const PAINTERS = (K) => {
  const { G } = K;
  return {
    code(f, b) { K.painters.teams(f, b); },          // (the same picture as the teams list: a list, and a side window of party icons over two lines)
    test(f, b) { K.strip(f, b); K.list(f, G.wide, b.list); },
    portrait(f, b) {
      K.strip(f, b);
      for (const c of b.cells) {
        K.box(f, c.head);
        K.head(f, { kind: 'preset', id: c.id }, c.head.x, c.head.y);
        K.chip(f, { ...c.chip, label: c.used ? 'IN USE' : '{NO}' + (c.id + 1), on: c.on });
      }
    },
  };
};
