// pokemonarena/js/builder_pick.js -- THE TEAM BUILDER, the PICKERS: long lists a player takes one row from.
//
//   builder-species   every Pokemon of the roster the team's rules allow (1018 under the standard rules), seven rows at a time, with the highlighted one's ROM front sprite and type badges
//                     beside the list. It is opened to ADD a Pokemon to the team (begin({ purpose: 'add' })) or to CHANGE the species of the open one ('change')
//   builder-item      the held items (those with a hold effect, unless the filter says ALL), NO ITEM first; the message box has the ROM's description
//
// REACHING A ROW IN A FEW PRESSES   up / down: a row (a held direction repeats and stops at the ends); L / R, the two page chips, the wheel: a page of seven; left / right: the next / previous
//   CHAPTER (a hundred Pokedex numbers, a first letter, or a type, by the sort); START: FIND, straight to the text entry; Y, X or the FILTER chip: the filter panel
//   (SORT, TYPE, EXCLUDED, FIND, CLEAR, DONE). Every one of these has a chip or a row in the picture: the hub's touch pad has only the d-pad, A and B.
// WHAT CANNOT BE PICKED, AND WHY   with EXCLUDED: SHOW the rows the rules leave out are listed last, greyed; A on one takes nothing and the message box says the rules module's reason.
// THE ENTER RULE OF THE SEARCH   editor_data.js speciesEnterChoice decides what an accepted FIND word takes: the species whose WHOLE name was typed, or the only one left. Anything else takes
//   nothing: the list is shown, filtered, with the count. (In the DOM editor Enter also took the FIRST row under the Pokedex order; there the list was on screen while the word was typed. Here
//   the keyboard covers it, so the first row is not guessed: it is under the cursor, one A away.)
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. Screens of builder_hub.js (its header has the screen interface and what X is). Nothing is edited until a
// row is taken, and then through X.dispatch (monAdd, monSet species, monSet heldItem): a row the reducer refuses stays unpicked with the reducer's words in the message box.
// SPEED   a query is one editor_data.js call (speciesSearch: 0.3 ms over the roster; itemCatalog: a few ms), made when the filter changes, never per frame; only the seven visible rows are built.

import { createList, chapterStep, plural, sentence } from './builder_parts.js';
import { BG, inR } from './builder_geom.js';

const CHIPS = BG.strip.pick;
const CHIP_LABEL = Object.freeze({ filter: 'FILTER', pgup: '{UP}', pgdn: '{DOWN}' });
const SORT_SHOWN = Object.freeze({ dex: 'POK{E}DEX', name: 'NAME', type: 'TYPE' });
export const FIND_MAX = 16;
const chipsView = (lv) => CHIPS.map((c) => ({ id: c.id, label: CHIP_LABEL[c.id], x: c.x, y: c.y, w: c.w, h: c.h, off: c.id === 'pgup' ? !lv.up : c.id === 'pgdn' ? !lv.down : false }));
const menuOf = (lv) => ({ rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.dim ? { disabled: true } : {}) })), cursor: lv.cursor });
const widest = (X, list) => list.reduce((a, s) => (X.measure('normal', s) > X.measure('normal', a) ? s : a), '');

/* ================================================================================================ the species picker */
function speciesScreen(X) {
  const list = createList(BG.list);
  const P = { purpose: null, q: '', type: null, excluded: false };
  const kit = () => X.kit();
  const pack = () => kit().pack;
  const ruleset = () => X.team().ruleset;
  const sort = () => { const s = X.prefs().speciesSort; return kit().ED.SPECIES_SORT_IDS.includes(s) ? s : 'dex'; };
  let found = { key: null, ids: [], hidden: 0 }, excl = { key: null, map: null };
  const exclusions = () => { if (excl.key !== ruleset()) excl = { key: ruleset(), map: kit().ED.speciesExclusions(pack(), ruleset()) }; return excl.map; };
  /** The ids the list shows now, and how many more the rules leave out (asked again only when the filter changes). */
  function ids() {
    const key = [ruleset(), P.q, sort(), P.type, P.excluded].join('|');
    if (found.key !== key) {
      const o = { sort: sort(), type: P.type };
      const all = kit().ED.speciesSearch(pack(), P.q, ruleset(), { ...o, unavailable: 'last' });
      const shown = P.excluded ? all : kit().ED.speciesSearch(pack(), P.q, ruleset(), { ...o, unavailable: 'hide' });
      found = { key, ids: shown, hidden: all.length - shown.length };
    }
    return found;
  }
  const info = (id) => kit().ED.speciesRow(pack(), id, ruleset(), exclusions());
  // (a row: the name and the Pokedex number; another FORM of a species shares its name and number, so its row says FORM where the number would be, and the side window shows which)
  const rowOf = (id) => { const r = info(id); return { id: 's:' + id, kind: 'item', label: kit().text(r.name), tag: !r.baseForm ? 'FORM' : r.natDex ? String(r.natDex) : '-', sid: id, ...(r.available ? {} : { dim: true }) }; };
  const source = (f) => ({ n: f.ids.length, at: (i) => rowOf(f.ids[i]) });
  // a chapter: the Pokemon that can be picked, by a hundred Pokedex numbers / a first letter / a first type; the ones the rules leave out (listed last) are chapters of their own
  function keyOf(i) {
    const id = ids().ids[i], sp = pack().species[id], r = info(id), s = sort();
    return (r.available ? 'a' : 'x') + (s === 'name' ? kit().text(sp.name).charAt(0).toUpperCase() : s === 'type' ? sp.types[0] : Math.floor(sp.natDex / 100));
  }
  function take(id) {
    const r = info(id);
    if (!r) return [];
    if (!r.available) { X.flash(sentence(kit().text(r.name) + ': ' + r.text), true); return []; }
    if (P.purpose === 'add') {
      const s = X.dispatch({ type: 'monAdd', teamId: X.team().id, species: id });
      if (!s || s.error || !s.result) return [];
      X.setAt({ monId: s.result.monId, tab: 'build' });
      return X.go('builder-mon', { replace: true });                 // the new Pokemon opens in the picker's place: B from it is the team
    }
    const m = X.mon();
    if (!m) return X.back();
    const s = X.dispatch({ type: 'monSet', monId: m.id, field: 'species', value: id });
    return s && !s.error ? X.back() : [];
  }
  function find() {
    X.popup.close();
    X.entry.open({ id: 'find', title: 'FIND A POK{E}MON', value: P.q, max: FIND_MAX, charset: 'search', allowEmpty: true }, (r) => {
      if (!r.ok) return [];
      P.q = r.value.trim().replace(/\s+/g, ' '); list.set(0);
      const f = ids();
      if (!P.q) return [];
      // THE ENTER RULE (the header has why the first row is not guessed): the whole name typed, or one Pokemon left
      const pick = kit().ED.speciesEnterChoice(pack(), f.ids, P.q, 'name');
      if (pick !== null) return take(pick);
      X.flash(f.ids.length ? f.ids.length + ' Pok{E}mon match "' + P.q + '". A takes the one highlighted.' : 'No Pok{E}mon match "' + P.q + '".');
      return [];
    });
    return [];
  }
  const typeChoices = () => [[null, 'ANY']].concat(kit().ED.speciesTypeChoices(pack()).map(([id, name]) => [id, name.toUpperCase()]));
  const FILTER_HELP = { sort: ['The order of the list. It is', 'remembered for next time.'], type: ['Only Pok{E}mon that have', 'this type.'], excluded: ['Also list the Pok{E}mon these rules', 'leave out, greyed, with the reason.'],
    find: ['Type a name, a Pok{E}dex number', 'or a type.'], clear: ['Show every Pok{E}mon again.', ''], done: ['Close this panel.', ''] };
  function filter() {
    X.popup.open({
      id: 'species-filter', title: 'FILTER',
      rows() {
        const tc = typeChoices(), t = tc.find((c) => c[0] === P.type) || tc[0];
        return [
          { id: 'sort', kind: 'choice', label: 'SORT', value: SORT_SHOWN[sort()], wide: SORT_SHOWN.dex },
          { id: 'type', kind: 'choice', label: 'TYPE', value: t[1], wide: widest(X, tc.map((c) => c[1])) },
          { id: 'excluded', kind: 'choice', label: 'EXCLUDED', value: P.excluded ? 'SHOW' : 'HIDE', wide: 'SHOW' },
          { id: 'find', kind: 'item', label: 'FIND', value: P.q || '-', wide: 'W'.repeat(FIND_MAX) },
          { id: 'clear', kind: 'item', label: 'CLEAR', stay: true },
          { id: 'done', kind: 'item', label: 'DONE' },
        ];
      },
      help: (r) => FILTER_HELP[r.id],
      pick(res) {
        if (res.kind === 'change') {
          if (res.row.id === 'sort') { const all = kit().ED.SPECIES_SORT_IDS; X.setPref('speciesSort', all[(all.indexOf(sort()) + res.dir + all.length) % all.length]); }
          else if (res.row.id === 'type') { const tc = typeChoices(), i = Math.max(0, tc.findIndex((c) => c[0] === P.type)); P.type = tc[(i + res.dir + tc.length) % tc.length][0]; }
          else if (res.row.id === 'excluded') P.excluded = !P.excluded;
          list.set(0); return [];
        }
        if (res.kind !== 'choose') return [];
        if (res.row.id === 'find') return find();
        if (res.row.id === 'clear') { P.q = ''; P.type = null; P.excluded = false; list.set(0); }
        return [];
      },
    });
    return [];
  }
  function helpOf(f, row) {
    if (!row) return 'No Pok{E}mon match that search.' + (f.hidden ? ' ' + f.hidden + ' more are left out by these rules.' : '');
    const name = kit().text(row.name);
    if (!row.available) return sentence(name + ': ' + row.text);
    return name + (row.baseForm ? '' : ' (another form)') + ': ' + row.types.map((t) => pack().types[t].name).join(' / ') + '. ' + (P.purpose === 'add' ? 'A adds it to the team.' : 'A changes the species to it.');
  }
  return {
    /** Say what the picker is opened for, BEFORE going to it: { purpose: 'add' | 'change' }. Every opening starts from the whole list. */
    begin(o) { P.purpose = o && (o.purpose === 'add' || o.purpose === 'change') ? o.purpose : null; P.q = ''; P.type = null; P.excluded = false; list.set(0); },
    ready: () => P.purpose === 'add' || (P.purpose === 'change' && !!X.mon()),
    press(action, pinfo) {
      const f = ids(), n = f.ids.length;
      switch (action) {
        case 'y': case 'x': return filter();
        case 'start': return find();
        case 'left': case 'right': if (n) list.set(chapterStep(n, list.cursor(n), action === 'left' ? -1 : 1, keyOf), n); return [];
        case 'a': return n ? take(f.ids[list.cursor(n)]) : [];
        case 'b': return X.back();
        default: list.press(action, source(f), pinfo); return [];
      }
    },
    pointer(ev) {
      const f = ids(), R = source(f);
      if (ev.kind === 'click') { const c = CHIPS.find((r) => inR(r, ev.x, ev.y)); if (c) { if (c.id === 'filter') return filter(); list.page(c.id === 'pgup' ? -1 : 1, R); return []; } }
      const r = list.pointer(ev, R);
      return r && (r.kind === 'choose' || r.kind === 'refused') ? take(r.row.sid) : [];
    },
    hit(x, y) { const c = CHIPS.find((r) => inR(r, x, y)); return c ? { kind: 'chip', id: c.id } : list.hit(x, y, source(ids())); },
    rects: () => list.rects(source(ids())).concat(CHIPS.map((c) => ({ ...c }))),
    state: () => ({ ...list.state(), purpose: P.purpose, q: P.q, type: P.type, excluded: P.excluded, sort: X.kit() ? sort() : 'dex' }),
    view() {
      const f = ids(), lv = list.view(source(f)), n = f.ids.length, id = n ? f.ids[list.cursor(n)] : null, row = id === null ? null : info(id);
      const what = [P.type !== null ? pack().types[P.type].name.toUpperCase() : '', P.q ? '"' + P.q + '"' : ''].filter(Boolean).join(' ') || 'POK{E}MON';
      return {
        kind: 'species', noTag: true, title: what + ': ' + n, chips: chipsView(lv), list: lv, menu: menuOf(lv), side: row ? { species: id, types: row.types.slice(), dim: !row.available } : null,
        help: helpOf(f, row),
        say: 'Choose a Pok{E}mon, ' + n + ' listed, sorted by ' + (sort() === 'dex' ? 'Pok{E}dex number' : sort()) + '. ' + (row ? kit().text(row.name) + (row.natDex ? ', number ' + row.natDex : '') + (row.available ? '' : ', cannot be picked') + '.' : ''),
      };
    },
  };
}

/* ================================================================================================ the held-item picker */
function itemScreen(X) {
  const list = createList(BG.wide);
  const P = { q: '', holdOnly: true, excluded: false };
  const kit = () => X.kit();
  const ruleset = () => X.team().ruleset;
  let found = { key: null, items: [], hidden: 0 };
  function entries() {
    const key = [ruleset(), P.q, P.holdOnly, P.excluded].join('|');
    if (found.key !== key) {
      const all = kit().ED.itemCatalog(kit().pack, ruleset(), { holdEffectOnly: P.holdOnly, q: P.q });
      const ok = all.filter((e) => e.status.ok);
      found = { key, items: P.excluded ? all : ok, hidden: all.length - ok.length };
    }
    return found;
  }
  const NONE = Object.freeze({ id: 'none', kind: 'item', label: 'NO ITEM', iid: 0 });
  const rowOf = (e) => ({ id: 'i:' + e.id, kind: 'item', label: kit().text(e.name), iid: e.id, ...(e.status.ok ? {} : { dim: true }) });
  const source = (f) => ({ n: f.items.length + 1, at: (i) => (i === 0 ? NONE : rowOf(f.items[i - 1])) });
  const keyOf = (i) => { if (i === 0) return ''; const e = entries().items[i - 1]; return (e.status.ok ? 'a' : 'x') + kit().text(e.name).charAt(0).toUpperCase(); };
  function take(i) {
    const f = entries(), m = X.mon(), e = i > 0 ? f.items[i - 1] : null;
    if (e && !e.status.ok) { X.flash(sentence(kit().text(e.name) + ': ' + e.status.text), true); return []; }
    const r = X.dispatch({ type: 'monSet', monId: m.id, field: 'heldItem', value: e ? e.id : 0 });
    return r && !r.error ? X.back() : [];
  }
  function find() {
    X.popup.close();
    X.entry.open({ id: 'find', title: 'FIND AN ITEM', value: P.q, max: FIND_MAX, charset: 'search', allowEmpty: true }, (r) => {
      if (!r.ok) return [];
      P.q = r.value.trim().replace(/\s+/g, ' '); list.set(0);
      const n = entries().items.length;
      if (P.q) { X.flash(n ? plural(n, 'item matches', 'items match') + ' "' + P.q + '".' : 'No item matches "' + P.q + '".'); if (n) list.set(1); }
      return [];
    });
    return [];
  }
  const FILTER_HELP = { hold: ['ONLY: the items that do something', 'when held. ALL: every item.'], excluded: ['Also list the items these rules', 'leave out, greyed, with the reason.'], find: ['Type part of a name or of', 'what the item does.'], clear: ['Show the whole list again.', ''], done: ['Close this panel.', ''] };
  function filter() {
    X.popup.open({
      id: 'item-filter', title: 'FILTER',
      rows: () => [
        { id: 'hold', kind: 'choice', label: 'HOLD ITEMS', value: P.holdOnly ? 'ONLY' : 'ALL', wide: 'ONLY' },
        { id: 'excluded', kind: 'choice', label: 'EXCLUDED', value: P.excluded ? 'SHOW' : 'HIDE', wide: 'SHOW' },
        { id: 'find', kind: 'item', label: 'FIND', value: P.q || '-', wide: 'W'.repeat(FIND_MAX) },
        { id: 'clear', kind: 'item', label: 'CLEAR', stay: true },
        { id: 'done', kind: 'item', label: 'DONE' },
      ],
      help: (r) => FILTER_HELP[r.id],
      pick(res) {
        if (res.kind === 'change') { if (res.row.id === 'hold') P.holdOnly = !P.holdOnly; else if (res.row.id === 'excluded') P.excluded = !P.excluded; list.set(0); return []; }
        if (res.kind !== 'choose') return [];
        if (res.row.id === 'find') return find();
        if (res.row.id === 'clear') { P.q = ''; P.holdOnly = true; P.excluded = false; list.set(0); }
        return [];
      },
    });
    return [];
  }
  function helpOf(f, i) {
    if (i === 0) return f.items.length || !P.q ? ['The Pok{E}mon holds nothing.', ''] : 'No item matches that search.' + (f.hidden ? ' ' + f.hidden + ' more are left out by these rules.' : '');
    const e = f.items[i - 1];
    return e.status.ok ? kit().flow(e.desc) || kit().text(e.name) : sentence(kit().text(e.name) + ': ' + e.status.text);
  }
  return {
    enter() {
      P.q = ''; P.holdOnly = true; P.excluded = false;
      const m = X.mon(), f = m ? entries() : null, i = f && m.heldItem ? f.items.findIndex((e) => e.id === m.heldItem) : -1;
      list.set(i >= 0 ? i + 1 : 0);
    },
    press(action, pinfo) {
      const f = entries(), n = f.items.length + 1;
      switch (action) {
        case 'y': case 'x': return filter();
        case 'start': return find();
        case 'left': case 'right': list.set(chapterStep(n, list.cursor(n), action === 'left' ? -1 : 1, keyOf), n); return [];
        case 'a': return take(list.cursor(n));
        case 'b': return X.back();
        default: list.press(action, source(f), pinfo); return [];
      }
    },
    pointer(ev) {
      const f = entries(), R = source(f);
      if (ev.kind === 'click') { const c = CHIPS.find((r) => inR(r, ev.x, ev.y)); if (c) { if (c.id === 'filter') return filter(); list.page(c.id === 'pgup' ? -1 : 1, R); return []; } }
      const r = list.pointer(ev, R);
      return r && (r.kind === 'choose' || r.kind === 'refused') ? take(r.index) : [];
    },
    hit(x, y) { const c = CHIPS.find((r) => inR(r, x, y)); return c ? { kind: 'chip', id: c.id } : list.hit(x, y, source(entries())); },
    rects: () => list.rects(source(entries())).concat(CHIPS.map((c) => ({ ...c }))),
    state: () => ({ ...list.state(), q: P.q, holdOnly: P.holdOnly, excluded: P.excluded }),
    view() {
      const f = entries(), R = source(f), lv = list.view(R), i = list.cursor(R.n), row = R.at(i);
      return {
        kind: 'item', noTag: true, title: (P.q ? '"' + P.q + '"' : P.holdOnly ? 'HELD ITEMS' : 'ALL ITEMS') + ': ' + f.items.length, chips: chipsView(lv), list: lv, menu: menuOf(lv),
        help: helpOf(f, i), say: 'Choose a held item for ' + X.monName(X.mon()) + ', ' + f.items.length + ' listed. ' + row.label + (row.dim ? ', cannot be held' : '') + '.',
      };
    },
  };
}

export const FAMILY = Object.freeze({
  id: 'pick',
  screens: Object.freeze({
    'builder-species': Object.freeze({ parent: 'builder-team', title: 'Team Builder: Choose a Pokemon', need: 'team', create: speciesScreen }),
    'builder-item': Object.freeze({ parent: 'builder-mon', title: 'Team Builder: Held Item', need: 'mon', create: itemScreen }),
  }),
});
