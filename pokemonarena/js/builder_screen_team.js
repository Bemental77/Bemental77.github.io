// pokemonarena/js/builder_screen_team.js -- the painters of THE TEAM BUILDER's TEAM family (builder_team.js): the team, its rules, its check.
//
// Pure ES module (browser + Node): no DOM, no timers. Drawn with builder_screen.js's furniture `K` (its header lists it); every pixel is the ROM's.
//   team    the name and LEGAL / n PROBLEMS in the strip; six of the ROM's party slot panels, two across (the highlighted one is the ROM's selected panel, an empty one its grey panel): the
//           Pokemon's ROM party icon, its name, its level and gender in the small font, and "!n" in the ROM's red when the rules find n problems with it; under them the chips
//   rules   the list (MODE, ITEM CLAUSE, DUPLICATES); beside it the ruleset's name in the small font, word-wrapped, and the team's status
//   check   one wide list: who and what on each row

import { slotRects } from './builder_geom.js';

export const PAINTERS = (K) => {
  const { G, t, TEXT, COL } = K;
  const SMALL = ['small', 'smallNarrow'];
  function slot(f, r, s, on) {
    K.ui.panel(f, r.x, r.y, r.w, r.h, on ? 'sel' : s.empty && !s.add ? 'grey' : 'normal', false);
    if (s.empty) { if (s.add) t(f, { s: '+ ADD', x: r.x + r.w / 2, y: r.y + 3, align: 'centre', max: r.w - 8, what: 'slot add' }); return; }
    if (!s.known || !K.icon(f, s.species, s.shiny, r.x + 1, r.y - 6, { x: r.x + 1, y: r.y + 1, w: 32, h: r.h - 2 })) t(f, { s: '?', x: r.x + 14, y: r.y + 3, what: 'no icon' });
    t(f, { s: s.name, x: r.x + 34, y: r.y - 2, max: r.w - 34 - 4, fonts: K.FONTS, what: 'slot name' });
    const lv = t(f, { s: '{LV}' + s.level, x: r.x + 34, y: r.y + 9, font: 'small', max: 30, what: 'slot level' });
    if (s.gender) t(f, { s: s.gender === 'M' ? '{MALE}' : '{FEMALE}', x: lv.x + lv.px + 4, y: r.y + 9, font: 'small', fg: s.gender === 'M' ? COL.blue : COL.red, what: 'slot gender' });
    if (s.problems) t(f, { s: '!' + Math.min(99, s.problems), x: r.x + r.w - 5, y: r.y + 9, align: 'right', font: 'small', max: 20, fg: COL.red, what: 'slot problems' });
  }
  return {
    team(f, b) {
      const T = G.team;
      t(f, { s: b.title, x: T.name.x, y: T.name.y, max: T.name.w, fonts: K.FONTS, ...K.onTeal, what: 'title' });
      t(f, { s: b.status.text, x: T.status.x, y: T.status.y, max: T.status.w, fonts: SMALL, fg: b.status.bad ? TEXT.orange : TEXT.white, sh: TEXT.dark, what: 'status' });
      if (b.tag) t(f, { s: b.tag.text, x: G.strip.tag.right, y: G.strip.tag.y, align: 'right', font: 'small', max: G.strip.tag.w, fg: b.tag.bad ? TEXT.orange : TEXT.white, sh: TEXT.dark, what: 'tag' });
      const rs = slotRects();
      b.slots.forEach((s, i) => slot(f, rs[i], s, b.cursor === i));
      b.chips.forEach((c, i) => K.chip(f, { ...c, on: b.cursor === b.slots.length + i }));
    },
    rules(f, b) {
      const S = G.side, s = b.side;
      K.strip(f, b); K.list(f, G.list, b.list); K.box(f, { x: S.x, y: S.y, w: S.w, h: S.h });
      K.wrap('small', s.label, S.w - 4, 6).forEach((ln, i) => t(f, { s: ln, x: S.x + 2, y: S.y + i * 10, font: 'small', max: S.w - 4, what: 'rules label' }));
      t(f, { s: s.status, x: S.x + 2, y: S.y + 74, max: S.w - 4, fonts: SMALL, fg: s.bad ? COL.red : COL.line, what: 'rules status' });
    },
    check(f, b) { K.strip(f, b); K.list(f, G.wide, b.list); },
  };
};
