// pokemonarena/js/builder_mon.js -- THE TEAM BUILDER, the POKEMON family: one Pokemon of a team, in tabs.
//
//   builder-mon   the Pokemon's ROM front sprite, its Pokedex number, level and type badges on the left; a strip of tabs (BUILD, MOVES, STATS: L / R, or a tap on a tab); the open tab on the right.
//     BUILD       SPECIES (the species picker), NICKNAME (the text entry), LEVEL, GENDER, SHINY, NATURE, ABILITY (left / right change them at once; A on LEVEL or FRIENDSHIP opens "type a
//                 number"), ITEM (the held-item picker), FRIENDSHIP, and a last row that says whether the Pokemon passes its team's rules (A opens the CHECK screen on it). The message box says
//                 what the highlighted row is: what a nature does, the ability's line from the ROM, why something is refused (the reducer's own words)
//     MOVES, STATS  arrive with the next stage: until a family registers them (X.ext('mon.tabs')), each is a plain note that says so
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. A screen of builder_hub.js (its header has the screen interface and what X is). Every edit is X.dispatch
// with the action the old DOM editor sent (monSet with its `coalesce` key, so a held direction is ONE undo step).
//
// A TAB (the entries of X.ext('mon.tabs'), and BUILD below): { id, label, create(X) -> { view(), press(action, info), pointer(ev), hit(x, y), rects(), state(), enter?() } }
//   view() -> { layout, help, say, ... }: `layout` names the painter builder_screen.js draws the tab with ('build' and 'note' exist; a new tab registers its own painter)
//   A tab registered with the id of a placeholder ('moves', 'stats') REPLACES it. L, R and the tab chips belong to the Pokemon screen; every other input goes to the open tab.
// numberMenu(X, spec) is the shared "numbers without sliders" pop-up (TYPE A NUMBER / the largest / the smallest): the STATS tab of the next stage uses it for EVs and IVs.

import { createList, plural, sentence } from './builder_parts.js';
import { BG, inR, tabRects } from './builder_geom.js';

export const TAB_IDS = Object.freeze(['build', 'moves', 'stats']);
const TAB_LABEL = Object.freeze({ build: 'BUILD', moves: 'MOVES', stats: 'STATS' });
const STAT_WORD = Object.freeze({ hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed' });

/**
 * "Type a number, or take the largest / the smallest": the pop-up a number row opens on A. spec: { id, label, value, min, max, set(n) } (set dispatches; the reducer clamps and says so).
 * What is typed must be a whole number (the text entry's 'code' keys: digits, and letters that are refused here with the DOM editor's words).
 */
export function numberMenu(X, spec) {
  const digits = String(spec.max).length;
  X.popup.open({
    id: 'number:' + spec.id, title: spec.label,
    rows: () => [{ id: 'type', label: 'TYPE A NUMBER' }, { id: 'max', label: 'MAX', value: String(spec.max) }, { id: 'min', label: 'MIN', value: String(spec.min) }],
    help: (r) => (r.id === 'type' ? ['Type ' + spec.label.toLowerCase() + ' as a number', '(' + spec.min + ' to ' + spec.max + ').'] : r.id === 'max' ? ['The largest: ' + spec.max + '.', ''] : ['The smallest: ' + spec.min + '.', '']),
    pick(res) {
      if (res.kind !== 'choose') return [];
      if (res.row.id === 'max') { spec.set(spec.max); return []; }
      if (res.row.id === 'min') { spec.set(spec.min); return []; }
      X.entry.open({ id: 'number', title: spec.label + '? (' + spec.min + '-' + spec.max + ')', value: String(spec.value), max: Math.max(digits, 3), charset: 'code' }, (r) => {
        if (!r.ok) return [];
        if (!/^\d{1,6}$/.test(r.value)) { X.flash(spec.label.charAt(0) + spec.label.slice(1).toLowerCase() + ': enter a whole number.', true); return []; }
        spec.set(Number(r.value)); return [];
      });
      return [];
    },
  });
  return [];
}

/* ================================================================================================ the BUILD tab */
function buildTab(X) {
  const list = createList(BG.mon.list);
  const kit = () => X.kit();
  const mon = () => X.mon();
  const rulesetId = () => X.team().ruleset;
  const R = () => X.rules(rulesetId());
  const species = (m) => kit().pack.species[m.species] || null;
  const set = (field, value, coalesce) => X.dispatch({ type: 'monSet', monId: mon().id, field, value, ...(coalesce ? { coalesce } : {}) });
  const natures = () => X.memo('natures', () => kit().ED.natureOptions(kit().pack));
  const abilities = (m) => X.memo('abil:' + m.species + ':' + rulesetId(), () => kit().ED.abilityOptions(kit().pack, m.species, rulesetId()).slots);
  const genders = (m) => kit().ED.genderOptions(kit().pack, m.species);
  const problems = (m) => X.memo('probs:' + m.id, () => kit().ED.monProblems(kit().pack, m, rulesetId()).problems);
  const item = (m) => (m.heldItem ? kit().pack.items[m.heldItem] || null : null);
  const itemName = (m) => { const it = item(m); return !m.heldItem ? 'NONE' : it && it.name ? kit().text(it.name) : 'Unknown ' + m.heldItem; };
  const genderShown = (g) => (g === 'M' ? '{MALE}' : g === 'F' ? '{FEMALE}' : '-');

  function rows() {
    const m = mon(), sp = species(m), n = problems(m).length;
    const last = { id: 'problems', kind: 'item', label: n ? 'PROBLEMS' : 'RULES', value: n ? String(n) : 'OK', bad: n > 0 };
    if (!sp) return [{ id: 'species', kind: 'item', label: 'SPECIES', value: 'Unknown ' + m.species }, { id: 'remove', kind: 'button', label: 'REMOVE FROM TEAM' }, last];
    const nat = natures()[m.nature], ab = abilities(m).find((s) => s.slot === m.abilitySlot);
    return [
      { id: 'species', kind: 'item', label: 'SPECIES', value: kit().text(sp.name) },
      { id: 'nickname', kind: 'item', label: 'NICKNAME', value: m.nickname || '-' },
      { id: 'level', kind: 'choice', label: 'LEVEL', value: String(m.level) },
      { id: 'gender', kind: 'choice', label: 'GENDER', value: genderShown(m.gender) },
      { id: 'shiny', kind: 'choice', label: 'SHINY', value: m.shiny ? 'YES' : 'NO' },
      { id: 'nature', kind: 'choice', label: 'NATURE', value: nat ? nat.name : String(m.nature) },
      { id: 'ability', kind: 'choice', label: 'ABILITY', value: ab ? kit().text(ab.name) : '-' },
      { id: 'item', kind: 'item', label: 'ITEM', value: itemName(m) },
      { id: 'friendship', kind: 'choice', label: 'FRIENDSHIP', value: String(m.friendship) },
      last,
    ];
  }
  /** Left / right (or A) on a choice row: one step, through the reducer. */
  function change(row, dir) {
    const m = mon();
    switch (row.id) {
      case 'level': set('level', m.level + dir, 'level:' + m.id); return [];
      case 'friendship': set('friendship', m.friendship + dir * 10, 'friend:' + m.id); return [];
      case 'shiny': set('shiny', !m.shiny); return [];
      case 'nature': { const n = Math.min(R().nature.count, natures().length); set('nature', (m.nature + dir + n) % n); return []; }
      case 'gender': { const g = genders(m); if (g.length < 2) { X.flash(g[0] === '-' ? 'This species has no gender.' : 'This species has one gender.'); return []; } set('gender', g[(g.indexOf(m.gender) + dir + g.length) % g.length]); return []; }
      case 'ability': {
        // the next slot the rules allow, in the direction pressed; when the reducer refuses every other slot, its reason for the nearest one is what the message box says
        const slots = abilities(m), i = Math.max(0, slots.findIndex((s) => s.slot === m.abilitySlot));
        if (slots.length < 2) { X.flash('This species has one ability.'); return []; }
        let first = null;
        for (let k = 1; k < slots.length; k++) {
          const r = X.dispatch({ type: 'monSet', monId: m.id, field: 'abilitySlot', value: slots[(i + dir * k + slots.length * k) % slots.length].slot }, { quiet: true });
          if (r && !r.error) return [];
          if (!first && r && r.error) first = r.error.message;
        }
        if (first) X.flash(sentence(first), true);
        return [];
      }
      default: return [];
    }
  }
  function choose(row) {
    const m = mon();
    switch (row.id) {
      case 'species': X.screen('builder-species').begin({ purpose: 'change' }); return X.go('builder-species');
      case 'nickname':
        X.entry.open({ id: 'nickname', title: 'NICKNAME?', value: m.nickname || '', max: kit().LIMITS.nickname, charset: 'name', allowEmpty: true }, (r) => { if (r.ok) set('nickname', r.value.trim()); return []; });
        return [];
      case 'item': return X.go('builder-item');
      case 'problems': X.screen('builder-check').begin(m.id); return X.go('builder-check');
      case 'remove': { const r = X.dispatch({ type: 'monRemove', teamId: X.team().id, monId: m.id }); return r && !r.error ? X.back() : []; }
      default: return [];
    }
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return X.back();
    if (r.kind === 'choose') return choose(r.row);
    if (r.kind !== 'change') return [];
    return change(r.row, r.dir);
  }
  /** A on a row: a number row opens "type a number"; any other choice row steps forward, as the hub's menus do. */
  function pressA() {
    const rs = rows(), row = rs[list.cursor(rs.length)], m = mon();
    if (row && row.id === 'level') { const L = R().level; return numberMenu(X, { id: 'level', label: 'LEVEL', value: m.level, min: L.min, max: L.max, set: (v) => set('level', v) }); }
    if (row && row.id === 'friendship') return numberMenu(X, { id: 'friendship', label: 'FRIENDSHIP', value: m.friendship, min: 0, max: 255, set: (v) => set('friendship', v) });
    return act(list.press('a', rs));
  }
  function helpOf(row) {
    const m = mon(), sp = species(m);
    if (!sp) return row && row.id === 'remove' ? ['Take this record out of the team.', ''] : 'This ROM has no Pok{E}mon with that number, so this record cannot be edited or used in a battle. Pick another species or remove it.';
    switch (row && row.id) {
      case 'species': return [kit().text(sp.name) + ': ' + kit().ED.uniqueTypes(sp).map((t) => kit().pack.types[t].name).join(' / ') + '.', 'A chooses another species.'];
      case 'nickname': return ['The name it goes by in battle.', 'A types one (up to ' + kit().LIMITS.nickname + ' characters).'];
      case 'level': {
        const L = R().level, d = kit().ED.derived(kit().pack, m, rulesetId());
        if (L.fixed !== null) return ['These rules fix the level at ' + L.fixed + '.', ''];
        return d.ok && d.level !== m.level ? 'Battles run at level ' + d.level + '; the level here decides which level-up moves are allowed.' : ['Battles run at this level.', 'A types a number.'];
      }
      case 'gender': { const g = genders(m); return g.length < 2 ? [g[0] === '-' ? 'This species has no gender.' : 'This species has one gender.', ''] : ['Left and right change the gender.', '']; }
      case 'shiny': return ['Shiny: the ROM\'s shiny palette', 'for this Pok{E}mon.'];
      case 'nature': { const n = natures()[m.nature]; return !n ? ['', ''] : n.neutral ? [n.name + ': no stat is changed.', ''] : [n.name + ': ' + STAT_WORD[n.up] + ' up,', STAT_WORD[n.down] + ' down.']; }
      case 'ability': { const ab = abilities(m).find((s) => s.slot === m.abilitySlot); return !ab ? ['', ''] : kit().text(ab.name) + (ab.hidden ? ' (hidden)' : '') + ': ' + (ab.allowed ? kit().flow(ab.short) : sentence(ab.text)); }
      case 'item': { const it = item(m); return !m.heldItem ? ['It holds nothing.', 'A chooses an item.'] : it ? kit().text(it.name) + ': ' + kit().flow(it.desc) : ['The ROM has no item ' + m.heldItem + '.', 'A chooses another.']; }
      case 'friendship': return ['Friendship, 0 to 255.', 'A types a number.'];
      case 'problems': { const ps = problems(m); return ps.length ? sentence(ps[0].label + ': ' + ps[0].text) : 'It passes ' + kit().ES.rulesetLabel(rulesetId()) + '.'; }
      default: return ['', ''];
    }
  }
  let shown = null;
  return {
    // (another Pokemon starts at the top; the SAME one, back from a picker or a tab, keeps the row it was on)
    enter() { const id = X.at().monId; if (id !== shown) { shown = id; list.set(0); } },
    press(action, info) { return action === 'a' ? pressA() : act(list.press(action, rows(), info)); },
    pointer: (ev) => act(list.pointer(ev, rows())),          // (a tap on the left half of a choice row steps back, on the right half forward)
    hit: (x, y) => list.hit(x, y, rows()),
    rects: () => list.rects(rows()),
    state: () => list.state(),
    view() {
      const m = mon(), rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)], ps = problems(m);
      return { layout: 'build', list: lv, menu: { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.value === undefined ? {} : { value: r.value }) })), cursor: lv.cursor }, help: helpOf(row), pagesFirst: false, say: (row ? row.label + ' ' + String(row.value === undefined ? '' : row.value).replace('{MALE}', 'male').replace('{FEMALE}', 'female') + '. ' : '') + (ps.length ? plural(ps.length, 'problem') + '.' : '') };
    },
  };
}

/** A tab that is not built yet: it says so, plainly. (The next stage registers the real one under the same id.) */
function noteTab(id) {
  return () => ({
    press: (action) => (action === 'b' ? null : []),
    pointer: () => [], hit: () => null, rects: () => [], state: () => ({}),
    view: () => ({ layout: 'note', lines: [TAB_LABEL[id], 'This screen arrives with', 'the next stage of the', 'Team Builder.'], help: ['Nothing to edit here yet.', 'L, R or a tap on a tab changes it.'], say: TAB_LABEL[id] + ' is not built yet.' }),
  });
}

/* ================================================================================================ the Pokemon screen */
function monScreen(X) {
  // the tabs: BUILD and the two placeholders, each replaced by a registered tab of the same id; a registered tab with a new id is added after them
  const defs = [{ id: 'build', label: TAB_LABEL.build, create: buildTab }, { id: 'moves', label: TAB_LABEL.moves, create: noteTab('moves') }, { id: 'stats', label: TAB_LABEL.stats, create: noteTab('stats') }];
  for (const e of X.ext('mon.tabs')) { const i = defs.findIndex((d) => d.id === e.id); if (i >= 0) defs[i] = e; else defs.push(e); }
  const tabs = defs.map((d) => ({ id: d.id, label: d.label, api: d.create(X) }));
  const index = () => Math.max(0, tabs.findIndex((t) => t.id === X.at().tab));
  const tab = () => tabs[index()];
  const rectsOfTabs = () => tabRects(tabs.length);
  function show(i) {
    const t = tabs[(i + tabs.length) % tabs.length];
    if (t.id === X.at().tab) return [];
    X.setAt({ tab: t.id });
    if (typeof t.api.enter === 'function') t.api.enter();
    return [X.eff('opened', { path: 'builder-mon', at: { ...X.at() }, profileId: X.activeId() })];          // (the ctl keeps the focus: a reload comes back to the same tab)
  }
  const tabHit = (x, y) => rectsOfTabs().findIndex((r) => inR(r, x, y));
  return {
    enter() { const t = tab(); if (t.id !== X.at().tab) X.setAt({ tab: t.id }); if (typeof t.api.enter === 'function') t.api.enter(); },
    press(action, info) {
      if (action === 'l') return show(index() - 1);
      if (action === 'r') return show(index() + 1);
      const fx = tab().api.press(action, info);
      return fx === null || fx === undefined ? (action === 'b' ? X.back() : []) : fx;
    },
    pointer(ev) {
      if (ev.kind !== 'wheel' && ev.x !== undefined && ev.x !== null) { const i = tabHit(ev.x, ev.y); if (i >= 0) return ev.kind === 'click' ? show(i) : []; }
      return tab().api.pointer(ev) || [];
    },
    hit(x, y) { const i = tabHit(x, y); return i >= 0 ? { kind: 'tab', index: i } : tab().api.hit(x, y); },
    rects: () => tab().api.rects().concat(rectsOfTabs()),          // (the open tab's own rectangles first, as on every list screen: rects()[i] is row i; then the tab chips)
    state: () => ({ tab: tab().id, ...tab().api.state() }),
    view() {
      const m = X.mon(), sp = X.kit().pack.species[m.species] || null, tv = tab().api.view(), tr = rectsOfTabs();
      const { help, pagesFirst, say, ...rest } = tv;
      return {
        kind: 'mon', title: X.monName(m), tab: tab().id, tabs: tabs.map((t, i) => ({ id: t.id, label: t.label, x: tr[i].x, y: tr[i].y, w: tr[i].w, h: tr[i].h })),
        mon: { species: m.species, known: !!sp, shiny: !!m.shiny, female: m.gender === 'F', dex: sp ? sp.natDex : 0, level: m.level, types: sp ? X.kit().ED.uniqueTypes(sp) : [] },
        ...rest, help, pagesFirst: !!pagesFirst,
        say: X.monName(m) + (sp && m.nickname ? ' the ' + X.speciesName(m.species) : '') + ', level ' + m.level + ', ' + tab().label + ' tab. ' + (say || ''),
      };
    },
  };
}

export const FAMILY = Object.freeze({
  id: 'mon',
  screens: Object.freeze({ 'builder-mon': Object.freeze({ parent: 'builder-team', title: 'Team Builder: Pokemon', need: 'mon', create: monScreen }) }),
});
