// pokemonarena/js/builder_portrait.js -- THE TEAM BUILDER, the PORTRAIT picker: the trainer's picture is one of the 52 trainer heads the ROM holds.
//
//   builder-portrait   three of the ROM's 64x64 trainer heads at a time (never shrunk), each in a ROM window with its number on a chip under it. LEFT / RIGHT: the next head (the page follows);
//                      UP / DOWN, L / R, the two page chips, the wheel: a page of three; A (or a tap on a head) takes it: the reducer's `avatar` action ({ kind: 'preset', id }), the DOM
//                      editor's; B goes back and changes nothing. It opens on the portrait in use.
// It is reached from the ACTIVE trainer's menu on the trainer list (PORTRAIT: the registration point 'trainers.menu'): the portrait is part of the profile being edited, as in the DOM editor.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. A screen of builder_hub.js (its header has the screen interface and what X is).

import { BG, inR, clamp, portraitRects } from './builder_geom.js';

const PER = BG.portrait.per;
const CHIPS = BG.strip.pick.slice(1);          // the two page chips, where the pickers have theirs
const CHIP_LABEL = Object.freeze({ pgup: '{UP}', pgdn: '{DOWN}' });

function portraitScreen(X) {
  let cur = 0;
  const count = () => X.kit().ES.AVATAR_PRESETS;
  const inUse = () => { const a = X.profile().avatar; return a && a.kind === 'preset' && Number.isInteger(a.id) ? a.id : -1; };
  const fit = () => { cur = clamp(cur, 0, count() - 1); return cur; };
  const first = () => Math.floor(fit() / PER) * PER;
  const pages = () => Math.ceil(count() / PER);
  function take(id) {
    const r = X.dispatch({ type: 'avatar', kind: 'preset', id });
    return r && !r.error ? X.back() : [];
  }
  /** A page up (-1) or down (+1): the same place on the page before / after, stopping at the ends. */
  function page(dir) { const n = count(), to = cur + dir * PER; if (to >= 0 && Math.floor(to / PER) < pages()) cur = Math.min(to, n - 1); }
  function hit(x, y) {
    const c = CHIPS.find((r) => inR(r, x, y)); if (c) return { kind: 'chip', id: c.id };
    const rs = portraitRects(), f = first();
    for (let i = 0; i < PER; i++) if (f + i < count() && inR(rs[i], x, y)) return { kind: 'head', id: f + i };
    return null;
  }
  return {
    enter() { cur = Math.max(0, inUse()); fit(); },
    press(action, info) {
      const n = count(); fit();
      switch (action) {
        case 'left': cur = cur > 0 ? cur - 1 : info && info.repeat ? 0 : n - 1; return [];
        case 'right': cur = cur < n - 1 ? cur + 1 : info && info.repeat ? n - 1 : 0; return [];
        case 'up': case 'l': page(-1); return [];
        case 'down': case 'r': page(1); return [];
        case 'a': return take(cur);
        case 'b': return X.back();
        default: return [];
      }
    },
    pointer(ev) {
      if (ev.kind === 'wheel') { page((ev.steps | 0) > 0 ? 1 : -1); return []; }
      const h = ev.x === undefined || ev.x === null ? null : hit(ev.x, ev.y);
      if (!h) return [];
      if (h.kind === 'chip') { if (ev.kind === 'click') page(h.id === 'pgup' ? -1 : 1); return []; }
      cur = h.id;
      return ev.kind === 'click' ? take(h.id) : [];
    },
    hit,
    rects() { const f = first(); return portraitRects().filter((_r, i) => f + i < count()).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })).concat(CHIPS.map((c) => ({ ...c }))); },
    state: () => ({ cursor: cur }),
    view() {
      const n = count(), f = first(), used = inUse(), rs = portraitRects(), pg = Math.floor(f / PER);
      return {
        kind: 'portrait', noTag: true, title: 'PORTRAIT ' + (cur + 1) + '/' + n,
        chips: CHIPS.map((c) => ({ id: c.id, label: CHIP_LABEL[c.id], x: c.x, y: c.y, w: c.w, h: c.h, off: c.id === 'pgup' ? pg === 0 : pg >= pages() - 1 })),
        cells: rs.map((r, i) => (f + i < n ? { id: f + i, head: r.head, chip: r.chip, on: f + i === cur, used: f + i === used } : null)).filter(Boolean),
        help: cur === used ? ['This is the portrait in use.', 'B goes back.'] : ['One of the ROM\'s ' + n + ' trainer portraits.', 'A takes it for ' + X.profile().trainerName + '.'],
        say: 'Choose a portrait for ' + X.profile().trainerName + '. Portrait ' + (cur + 1) + ' of ' + n + (cur === used ? ', the one in use' : '') + '.',
      };
    },
  };
}

export const FAMILY = Object.freeze({
  id: 'portrait',
  screens: Object.freeze({ 'builder-portrait': Object.freeze({ parent: 'builder', title: 'Team Builder: Portrait', need: 'profile', create: portraitScreen }) }),
  ext: Object.freeze({
    'trainers.menu': [Object.freeze({ id: 'portrait', label: 'PORTRAIT', help: ['Choose the trainer\'s picture: one', 'of the ROM\'s trainer portraits.'], when: (X, t) => !!t && t.id === X.activeId(), run: (X) => X.go('builder-portrait') })],
  }),
});
