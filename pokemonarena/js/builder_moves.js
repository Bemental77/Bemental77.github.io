// pokemonarena/js/builder_moves.js -- THE TEAM BUILDER, the MOVES family: a Pokemon's four moves, and the picker a move is taken from.
//
//   the MOVES tab   (registered on the Pokemon screen: X.ext('mon.tabs')) four slots, each the move's ROM type badge, its name and its category icon; under them one line with the highlighted
//                   move's power, accuracy and PP; the message box has the ROM's description. A on a move opens its menu (CHANGE, UP, DOWN, REMOVE); A on the first empty slot opens the picker
//                   to add one. Then UNDO and REDO
//   builder-move    the picker for one slot: the moves this Pokemon's line can learn (usable ones first, in the order chosen), six rows at a time, each with where it comes from (Lv 12,
//                   TM24, Tutor, Egg); a foot line has the highlighted move's numbers, type badge and category icon; the message box has the description, or WHY a row cannot be taken (the
//                   rules module's reason; "already knows this move")
//
// REACHING A ROW   up / down: a row; L / R, the two page chips, the wheel: a page of six; left / right: the next / previous CHAPTER (a first letter, a type, a band of power or of level, by
//   the sort); START: FIND; Y, X or the FILTER chip: the filter panel, which has everything the DOM editor's picker had: TYPE, CATEGORY, POWER, SOURCE, SORT, USABLE (only the moves that can
//   be taken), UNLEARNABLE (also list the moves it cannot learn, grey, with the reason), FIND, CLEAR, DONE.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. Screens of builder_hub.js (its header has the screen interface and what X is). Every edit is X.dispatch
// with the DOM editor's actions: moveSet { monId, slot, moveId } (null clears), moveReorder { monId, from, to }; a move the reducer refuses stays unpicked, with the reducer's words.
// SPEED   one editor_data.js moveCatalog per Pokemon (a few ms; 8 to 11 ms with the unlearnable moves, made only when they are asked for), one filterMoves per change of the filter; both are
//   kept until the profile changes (X.memo). Only the six visible rows are built per frame.

import { createList, chapterStep, plural, sentence } from './builder_parts.js';
import { BG, inR } from './builder_geom.js';
import { undoRows, undoHelp, undoAct, isUndoRow } from './builder_undo.js';

export const MOVE_SLOTS = 4;
export const FIND_MAX = 16;
/** The room a row keeps for its source tags (the small font): the longest move name of the ROM still fits beside it. */
export const TAG_PX = 56;
const CAT_WORD = Object.freeze(['Physical', 'Special', 'Status']);
const CHIPS = BG.strip.pick;
const CHIP_LABEL = Object.freeze({ filter: 'FILTER', pgup: '{UP}', pgdn: '{DOWN}' });
const CATS = Object.freeze([[null, 'ANY'], [0, 'PHYSICAL'], [1, 'SPECIAL'], [2, 'STATUS']]);
const POWERS = Object.freeze([['', 'ANY'], ['none', 'NONE'], ['1-50', '1-50'], ['51-80', '51-80'], ['81-110', '81-110'], ['111-', '111+']]);
const SOURCES = Object.freeze([['', 'ANY'], ['levelUp', 'LEVEL-UP'], ['machine', 'TM / HM'], ['tutor', 'TUTOR'], ['egg', 'EGG']]);
const SORTS = Object.freeze([['name', 'NAME'], ['power', 'POWER'], ['type', 'TYPE'], ['level', 'LEVEL']]);
const powerText = (e) => (e.category === 2 || !e.power ? '-' : String(e.power));
const accText = (e) => (e.accuracy ? e.accuracy + '%' : '-');
const cycle = (list, value, dir) => { const i = Math.max(0, list.findIndex((c) => c[0] === value)); return list[(i + dir + list.length) % list.length][0]; };
const shownOf = (list, value) => (list.find((c) => c[0] === value) || list[0])[1];
const widest = (X, list) => list.reduce((a, s) => (X.measure('normal', s) > X.measure('normal', a) ? s : a), '');
/** A move's numbers as words (the screen reader's; the picture has the badge and the icon). */
const spoken = (X, e) => { const ty = X.kit().pack.types[e.type]; return (ty ? ty.name : 'no type') + ', ' + (CAT_WORD[e.category] || 'no category') + ', ' + (e.category === 2 || !e.power ? 'no power' : 'power ' + e.power) + ', ' + (e.accuracy ? 'accuracy ' + e.accuracy : 'never misses') + ', ' + e.pp + ' PP'; };

/* ================================================================================================ the MOVES tab */
function movesTab(X) {
  const list = createList(BG.moves.list);
  const kit = () => X.kit();
  const mon = () => X.mon();
  const moveOf = (id) => kit().pack.moves[id] || null;
  function rows() {
    const m = mon(), n = m.moves.length, out = [];
    for (let i = 0; i < MOVE_SLOTS; i++) {
      const mv = m.moves[i];
      if (!mv) { out.push({ id: 'm:' + i, kind: 'item', slot: i, label: i === n ? '+ ADD A MOVE' : '-', empty: true, ...(i === n ? {} : { dim: true }) }); continue; }
      const d = moveOf(mv.id);
      out.push(d ? { id: 'm:' + i, kind: 'item', slot: i, label: kit().text(d.name), mid: mv.id, type: d.type, category: d.category, power: d.power, accuracy: d.accuracy, pp: d.pp }
        : { id: 'm:' + i, kind: 'item', slot: i, label: 'Unknown move ' + mv.id, mid: mv.id, unknown: true });
    }
    return out.concat(undoRows(X));
  }
  function openPicker(slot) { X.screen('builder-move').begin({ slot }); return X.go('builder-move'); }
  const MENU_HELP = { change: ['Choose another move', 'for this slot.'], up: ['Move it one slot up.', ''], down: ['Move it one slot down.', ''], remove: ['Forget this move.', ''] };
  function moveMenu(slot) {
    const m0 = mon(), mid = m0.moves[slot].id, monId = m0.id, title = rows()[slot].label;
    const where = () => { const m = mon(); return m ? m.moves.findIndex((x) => x.id === mid) : -1; };
    X.popup.open({
      id: 'move', title,
      rows() {
        const i = where(), n = mon().moves.length;
        return [{ id: 'change', label: 'CHANGE' }, { id: 'up', label: 'UP', stay: true, ...(i <= 0 ? { disabled: true } : {}) }, { id: 'down', label: 'DOWN', stay: true, ...(i >= n - 1 ? { disabled: true } : {}) }, { id: 'remove', label: 'REMOVE', ...(n <= 1 ? { disabled: true } : {}) }];
      },
      help: (r) => MENU_HELP[r.id],
      pick(res) {
        const i = where(); if (i < 0) return [];
        if (res.kind === 'refused') {
          if (res.row.id === 'remove') X.dispatch({ type: 'moveSet', monId, slot: i, moveId: null });          // (the reducer says why: a Pokemon needs at least one move)
          else X.flash(res.row.id === 'up' ? 'It is already the first move.' : 'It is already the last move.');
          return [];
        }
        if (res.kind !== 'choose') return [];
        switch (res.row.id) {
          case 'change': return openPicker(i);
          case 'up': X.dispatch({ type: 'moveReorder', monId, from: i, to: i - 1 }); list.set(Math.max(0, where())); return [];
          case 'down': X.dispatch({ type: 'moveReorder', monId, from: i, to: i + 1 }); list.set(Math.max(0, where())); return [];
          default: X.dispatch({ type: 'moveSet', monId, slot: i, moveId: null }); return [];
        }
      },
    });
    return [];
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return X.back();
    if (r.kind !== 'choose' && r.kind !== 'refused') return [];
    if (isUndoRow(r.row.id)) return undoAct(X, r.row.id);          // (a grey one says there is nothing to undo)
    if (r.row.empty) return openPicker(mon().moves.length);        // (the slots fill in order: an empty one adds the NEXT move)
    return moveMenu(r.row.slot);
  }
  function helpOf(row) {
    if (!row) return ['', ''];
    if (isUndoRow(row.id)) return undoHelp(X, row.id);
    if (row.empty) return row.dim ? ['An empty slot. The slots fill in', 'order: A adds the next move.'] : ['An empty slot.', 'A chooses a move for it.'];
    if (row.unknown) return 'This ROM has no move with that number. A replaces it or removes it.';
    return kit().flow(moveOf(row.mid).desc) || row.label;
  }
  let shown = null;
  return {
    enter() { const id = X.at().monId; if (id !== shown) { shown = id; list.set(0); } },
    press: (action, info) => act(list.press(action, rows(), info)),
    pointer: (ev) => act(list.pointer(ev, rows())),
    hit: (x, y) => list.hit(x, y, rows()),
    rects: () => list.rects(rows()),
    state: () => list.state(),
    view() {
      const rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)], full = row && row.mid !== undefined && !row.unknown;
      return {
        layout: 'moves', list: lv, info: full ? { power: powerText(row), accuracy: accText(row), pp: String(row.pp) } : null,
        menu: { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.disabled ? { disabled: true } : {}) })), cursor: lv.cursor },
        help: helpOf(row), pagesFirst: false,
        say: !row ? '' : isUndoRow(row.id) ? row.label + '.' : 'Move ' + (row.slot + 1) + ': ' + (row.empty ? 'empty' : full ? row.label + ', ' + spoken(X, row) : row.label) + '.',
      };
    },
  };
}

/* ================================================================================================ the move picker */
function moveScreen(X) {
  const list = createList(BG.mpick.list);
  const P = { slot: null, q: '', type: null, category: null, power: '', source: '', sort: 'name', usable: false, all: false };
  const kit = () => X.kit();
  const pack = () => kit().pack;
  const mon = () => X.mon();
  const reset = () => { P.q = ''; P.type = null; P.category = null; P.power = ''; P.source = ''; P.sort = 'name'; P.usable = false; P.all = false; };
  const catalog = () => { const m = mon(); return X.memo('mcat:' + m.id + ':' + (P.all ? 1 : 0), () => kit().ED.moveCatalog(pack(), m, X.team().ruleset, { allMoves: P.all })); };
  /** The moves the list shows now (asked again only when the filter or the profile changes). */
  function found() {
    const m = mon();
    return X.memo('mfound:' + m.id + ':' + JSON.stringify([P.q, P.type, P.category, P.power, P.source, P.sort, P.usable, P.all]), () => {
      const pm = /^(\d+)-(\d*)$/.exec(P.power);
      const range = P.power === 'none' ? { powerMax: 0 } : pm ? { powerMin: Number(pm[1]), powerMax: pm[2] === '' ? undefined : Number(pm[2]) } : {};
      return kit().ED.filterMoves(catalog(), { q: P.q, type: P.type, category: P.category, source: P.source, sort: P.sort, onlyAvailable: P.usable, ...range });
    });
  }
  const known = () => new Set(mon().moves.map((x) => x.id));
  const currentId = () => { const mv = mon().moves[P.slot]; return mv ? mv.id : null; };
  const dup = (e) => known().has(e.id) && e.id !== currentId();
  const okRow = (e) => e.status.ok && !dup(e);
  /** Why a row cannot be taken: the rules module's words, with its own detail (the level a level-up move needs). */
  function why(e) {
    if (dup(e)) return 'This Pok{E}mon already knows this move.';
    const st = e.status;
    let s = st.text || st.message || st.code;
    if (st.reason) s = s + ': ' + st.reason;
    s = sentence(s);
    return st.why === 'level-too-low' && st.needLevel ? s + ' It needs level ' + st.needLevel + '.' : s;
  }
  // where a move comes from, as many of its sources as fit the room a row keeps for them (Lv 12 TM24); the foot line and the screen reader have them all
  function tagOf(e) {
    let s = '';
    for (const t of e.tags) { const next = s ? s + ' ' + t.label : t.label; if (X.measure('small', next) > TAG_PX) break; s = next; }
    return s;
  }
  const rowOf = (e) => ({ id: 'v:' + e.id, kind: 'item', label: kit().text(e.name), tag: tagOf(e), mid: e.id, ...(okRow(e) ? {} : { dim: true }) });
  const source = (f) => ({ n: f.length, at: (i) => rowOf(f[i]) });
  // a chapter: the usable moves by first letter / type / twenty-five points of power / ten levels; the ones that cannot be taken (listed last) are chapters of their own
  function keyOf(i) {
    const e = found()[i];
    const k = P.sort === 'type' ? e.type : P.sort === 'power' ? (e.category === 2 || !e.power ? 'none' : Math.floor((e.power - 1) / 25)) : P.sort === 'level' ? (e.learnLevel === null ? 'none' : Math.floor(e.learnLevel / 10)) : kit().text(e.name).charAt(0).toUpperCase();
    return (e.status.ok ? 'a' : 'x') + k;
  }
  function take(i) {
    const e = found()[i], m = mon();
    if (!e || !m) return [];
    if (!okRow(e)) { X.flash(why(e), true); return []; }
    const r = X.dispatch({ type: 'moveSet', monId: m.id, slot: P.slot, moveId: e.id });
    return r && !r.error ? X.back() : [];
  }
  function find() {
    X.popup.close();
    X.entry.open({ id: 'find', title: 'FIND A MOVE', value: P.q, max: FIND_MAX, charset: 'search', allowEmpty: true }, (r) => {
      if (!r.ok) return [];
      P.q = r.value.trim().replace(/\s+/g, ' '); list.set(0);
      const n = found().length;
      if (P.q) X.flash(n ? plural(n, 'move matches', 'moves match') + ' "' + P.q + '".' + (n === 1 ? '' : ' A takes the one highlighted.') : 'No move matches "' + P.q + '".');
      return [];
    });
    return [];
  }
  const typeChoices = () => [[null, 'ANY']].concat(pack().types.filter((t) => t.id >= 1 && t.id <= 19 && t.id !== 10).map((t) => [t.id, t.name.toUpperCase()]));
  const FILTER_HELP = {
    type: ['Only moves of this type.', ''], category: ['Only physical, special', 'or status moves.'], power: ['Only moves in this band', 'of power.'], source: ['Only moves it learns this way.', ''],
    sort: ['The order of the list. Moves that', 'cannot be taken come last.'], usable: ['ONLY: leave out the moves', 'that cannot be taken.'], all: ['SHOW: also list the moves it cannot', 'learn, greyed, with the reason.'],
    find: ['Type part of a move\'s name.', ''], clear: ['Show the whole list again.', ''], done: ['Close this panel.', ''],
  };
  function filter() {
    X.popup.open({
      id: 'move-filter', title: 'FILTER',
      rows() {
        const tc = typeChoices();
        return [
          { id: 'type', kind: 'choice', label: 'TYPE', value: shownOf(tc, P.type), wide: widest(X, tc.map((c) => c[1])) },
          { id: 'category', kind: 'choice', label: 'CATEGORY', value: shownOf(CATS, P.category), wide: 'PHYSICAL' },
          { id: 'power', kind: 'choice', label: 'POWER', value: shownOf(POWERS, P.power), wide: '81-110' },
          { id: 'source', kind: 'choice', label: 'SOURCE', value: shownOf(SOURCES, P.source), wide: 'LEVEL-UP' },
          { id: 'sort', kind: 'choice', label: 'SORT', value: shownOf(SORTS, P.sort), wide: 'POWER' },
          { id: 'usable', kind: 'choice', label: 'USABLE', value: P.usable ? 'ONLY' : 'ALL', wide: 'ONLY' },
          { id: 'all', kind: 'choice', label: 'UNLEARNABLE', value: P.all ? 'SHOW' : 'HIDE', wide: 'SHOW' },
          { id: 'find', kind: 'item', label: 'FIND', value: P.q || '-', wide: 'W'.repeat(FIND_MAX) },
          { id: 'clear', kind: 'item', label: 'CLEAR', stay: true },
          { id: 'done', kind: 'item', label: 'DONE' },
        ];
      },
      help: (r) => FILTER_HELP[r.id],
      pick(res) {
        if (res.kind === 'change') {
          switch (res.row.id) {
            case 'type': P.type = cycle(typeChoices(), P.type, res.dir); break;
            case 'category': P.category = cycle(CATS, P.category, res.dir); break;
            case 'power': P.power = cycle(POWERS, P.power, res.dir); break;
            case 'source': P.source = cycle(SOURCES, P.source, res.dir); break;
            case 'sort': P.sort = cycle(SORTS, P.sort, res.dir); break;
            case 'usable': P.usable = !P.usable; break;
            default: P.all = !P.all;
          }
          list.set(0); return [];
        }
        if (res.kind !== 'choose') return [];
        if (res.row.id === 'find') return find();
        if (res.row.id === 'clear') { reset(); list.set(0); }
        return [];
      },
    });
    return [];
  }
  return {
    /** Say which slot the picker fills, BEFORE going to it: { slot } (0..3, at most the first empty one). Every opening starts from the whole list of learnable moves. */
    begin(o) { P.slot = o && Number.isInteger(o.slot) && o.slot >= 0 && o.slot < MOVE_SLOTS ? o.slot : null; reset(); list.set(0); },
    ready: () => P.slot !== null && !!mon() && P.slot <= mon().moves.length,
    // (opened on a slot that has a move: the cursor starts on that move)
    enter() { const id = currentId(), f = found(); if (id !== null) list.seek(source(f), (r) => r.mid === id); },
    press(action, pinfo) {
      const f = found(), n = f.length;
      switch (action) {
        case 'y': case 'x': return filter();
        case 'start': return find();
        case 'left': case 'right': if (n) list.set(chapterStep(n, list.cursor(n), action === 'left' ? -1 : 1, keyOf), n); return [];
        case 'a': return n ? take(list.cursor(n)) : [];
        case 'b': return X.back();
        default: list.press(action, source(f), pinfo); return [];
      }
    },
    pointer(ev) {
      const f = found(), R = source(f);
      if (ev.kind === 'click') { const c = CHIPS.find((r) => inR(r, ev.x, ev.y)); if (c) { if (c.id === 'filter') return filter(); list.page(c.id === 'pgup' ? -1 : 1, R); return []; } }
      const r = list.pointer(ev, R);
      return r && (r.kind === 'choose' || r.kind === 'refused') ? take(r.index) : [];
    },
    hit(x, y) { const c = CHIPS.find((r) => inR(r, x, y)); return c ? { kind: 'chip', id: c.id } : list.hit(x, y, source(found())); },
    rects: () => list.rects(source(found())).concat(CHIPS.map((c) => ({ ...c }))),
    state: () => ({ ...list.state(), slot: P.slot, q: P.q, type: P.type, category: P.category, power: P.power, source: P.source, sort: P.sort, usable: P.usable, all: P.all }),
    view() {
      const f = found(), lv = list.view(source(f)), n = f.length, e = n ? f[list.cursor(n)] : null;
      const usable = X.memo('musable:' + mon().id + ':' + P.slot + ':' + JSON.stringify([P.q, P.type, P.category, P.power, P.source, P.sort, P.usable, P.all]), () => f.filter(okRow).length);
      return {
        kind: 'move', noTag: true, title: (P.q ? '"' + P.q + '"' : 'MOVE ' + (P.slot + 1)) + ': ' + n,
        chips: CHIPS.map((c) => ({ id: c.id, label: CHIP_LABEL[c.id], x: c.x, y: c.y, w: c.w, h: c.h, off: c.id === 'pgup' ? !lv.up : c.id === 'pgdn' ? !lv.down : false })),
        list: lv, menu: { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.dim ? { disabled: true } : {}) })), cursor: lv.cursor },
        info: e ? { type: e.type, category: e.category, power: powerText(e), accuracy: accText(e), pp: String(e.pp) } : null,
        help: !e ? 'No move matches that search.' : okRow(e) ? kit().flow(e.desc) || kit().text(e.name) : why(e),
        say: 'Choose move ' + (P.slot + 1) + ' for ' + X.monName(mon()) + ', ' + n + ' listed, ' + usable + ' can be taken. ' + (e ? kit().text(e.name) + ', ' + spoken(X, e) + (e.tags.length ? ', ' + e.tags.map((t) => t.label).join(', ') : '') + (okRow(e) ? '' : ', cannot be taken') + '.' : ''),
      };
    },
  };
}

export const FAMILY = Object.freeze({
  id: 'moves',
  screens: Object.freeze({ 'builder-move': Object.freeze({ parent: 'builder-mon', title: 'Team Builder: Choose a Move', need: 'mon', create: moveScreen }) }),
  ext: Object.freeze({ 'mon.tabs': [Object.freeze({ id: 'moves', label: 'MOVES', create: movesTab })] }),
});
