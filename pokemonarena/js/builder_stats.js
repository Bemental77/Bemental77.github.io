// pokemonarena/js/builder_stats.js -- THE TEAM BUILDER, the STATS tab of the Pokemon screen: effort (EVs, or stat points), IVs, Hidden Power, the quick actions.
//
//   EDIT            the first row: WHAT LEFT / RIGHT CHANGE on the six rows under it: EVS, POINTS (stat points: 1 point = +1 to a stat at level 50) or IVS. Beside it, always in sight, the BUDGET:
//                   "2 LEFT OF 510" / "5 LEFT OF 66", or how far over it is. Under rules that store stat points (the Champions layer) there are no EVs to edit: the choice is POINTS or IVS
//   six stat rows   the stat's name, the ROM's arrow where the nature raises or lowers it, the battle stat the rules module works out, the ROM's bar for it, the EVs (or points) and the IV.
//                   The number being edited is dark, the other grey. LEFT / RIGHT: one step (4 EVs, 1 point, 1 IV); every step of a run on one number carries the same `coalesce` key, so a
//                   HELD DIRECTION IS ONE UNDO STEP (the DOM editor's slider did the same with its drag key). A: the numbers pop-up (builder_mon.js numberMenu): TYPE A NUMBER, MAX, +40 / -40
//                   (EVs; +8 / -8 points), MIN. A tap on a number's left half steps it down, on its right half up; a tap on the OTHER number makes that one the one being edited
//   HIDDEN POWER    its type (the ROM badge) and power as the IVs make them; A lists the sixteen types, and the one taken sets the IVs (ivPreset 'hp:<type>')
//   QUICK ACTIONS   (the row, START or X) RESET, SNAP, ALL 31, 0 ATK, 0 SPE, 0 ATK+SPE, ALL 0
//   UNDO, REDO
// What the reducer answers ("EV was limited to 252", "these rules fix every IV at 31") goes to the message box: nothing here clamps or judges a number.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. A tab of builder_mon.js (its header has the tab interface). Every edit is X.dispatch with the DOM
// editor's actions: evSet { monId, stat, value, mode: 'ev' | 'points', coalesce }, ivSet { monId, stat, value, coalesce }, ivPreset { monId, preset }, evReset, evSnap.
// The EVs / points view is a per-viewer preference (X.setPref('statsView'): the ctl keeps it under the DOM editor's key); it is never part of the profile and never an undo step.

import { createList } from './builder_parts.js';
import { BG, inR, statCells } from './builder_geom.js';
import { numberMenu } from './builder_mon.js';
import { undoRows, undoHelp, undoAct, isUndoRow } from './builder_undo.js';

const SHORT = Object.freeze({ hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' });
const LONG = Object.freeze({ hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed' });
export const STAT_MODES = Object.freeze(['ev', 'points', 'iv']);
const MODE_SHOWN = Object.freeze({ ev: 'EVS', points: 'POINTS', iv: 'IVS' });
/** How far one press of left / right moves a number, and the jumps the pop-up offers. */
export const STEP = Object.freeze({ ev: 4, points: 1, iv: 1 });
export const JUMPS = Object.freeze({ ev: [40], points: [8], iv: [] });
/** The quick actions, in the DOM editor's order, each the reducer action it sends. */
export const QUICK = Object.freeze([
  { id: 'reset', label: 'RESET', action: { type: 'evReset' }, help: ['Set every EV (every stat point)', 'back to 0.'] },
  { id: 'snap', label: 'SNAP', action: { type: 'evSnap' }, help: ['Lower each EV to the cheapest', 'value that buys the same stat.'] },
  { id: 'all31', label: 'ALL 31', action: { type: 'ivPreset', preset: 'all31' }, help: ['Every IV at its largest.', ''] },
  { id: 'zeroAtk', label: '0 ATK', action: { type: 'ivPreset', preset: 'zeroAtk' }, help: ['The Attack IV at its smallest,', 'the others at their largest.'] },
  { id: 'zeroSpe', label: '0 SPE', action: { type: 'ivPreset', preset: 'zeroSpe' }, help: ['The Speed IV at its smallest,', 'the others at their largest.'] },
  { id: 'zeroAtkSpe', label: '0 ATK+SPE', action: { type: 'ivPreset', preset: 'zeroAtkSpe' }, help: ['The Attack and Speed IVs at their', 'smallest, the others at their largest.'] },
  { id: 'all0', label: 'ALL 0', action: { type: 'ivPreset', preset: 'all0' }, help: ['Every IV at its smallest.', ''] },
]);
/** What a full bar stands for at a battle level: the stat a base of 150 reaches with every IV and EV (HP), and with a raising nature (the others). The DOM editor's scale. */
export function statScale(level) {
  const core = Math.floor(((2 * 150 + 31 + 63) * level) / 100);
  return { hp: core + level + 10, other: Math.floor(1.1 * (core + 5)) };
}

function statsTab(X) {
  const list = createList(BG.stats.list);
  let ivMode = false, shown = null;
  const kit = () => X.kit();
  const mon = () => X.mon();
  const rulesetId = () => X.team().ruleset;
  const R = () => X.rules(rulesetId());
  const order = () => kit().ED.STAT_ORDER;
  /** How effort is shown: 'points' when the rules store points, else the viewer's own choice. */
  const effView = () => (R().points ? 'points' : X.prefs().statsView === 'points' ? 'points' : 'ev');
  /** What left / right change: 'ev' | 'points' | 'iv'. */
  const mode = () => (ivMode ? 'iv' : effView());
  const modes = () => (R().points ? ['points', 'iv'] : STAT_MODES);
  const derived = () => { const m = mon(); return X.memo('derived:' + m.id, () => kit().ED.derived(kit().pack, m, rulesetId())); };
  const budgets = () => { const m = mon(); return X.memo('budgets:' + m.id, () => { try { return kit().ED.budgets(m, rulesetId()); } catch (_e) { return null; } }); };
  const ivOf = (m, k) => (R().iv.fixed !== null ? R().iv.fixed : m.iv[k]);

  function budgetOf() {
    const b = budgets(); if (!b) return null;
    const x = effView() === 'points' ? b.points : b.ev;
    if (!x) return { text: 'NO TOTAL CAP', bad: false, say: 'No total cap; each stat up to ' + b.evPerStat + '.' };
    const unit = effView() === 'points' ? 'points' : 'EV';
    return x.over ? { text: (-x.remaining) + ' OVER ' + x.total, bad: true, say: (-x.remaining) + ' ' + unit + ' over the ' + x.total + '.' } : { text: x.remaining + ' LEFT OF ' + x.total, bad: false, say: x.remaining + ' ' + unit + ' left of ' + x.total + '.' };
  }
  function rows() {
    const m = mon(), d = derived();
    if (!d.ok) return [{ id: 'none', kind: 'item', label: 'NO STATS TO SHOW', dim: true }].concat(undoRows(X));
    const md = mode(), ev = effView(), sc = statScale(d.level), nat = d.nature;
    const out = [{ id: 'edit', kind: 'choice', label: 'EDIT', value: MODE_SHOWN[md], budget: budgetOf() }];
    for (const k of order()) {
      out.push({ id: 's:' + k, kind: 'choice', stat: k, label: SHORT[k], nat: nat && nat.up === k ? 1 : nat && nat.down === k ? -1 : 0, value: String(d.stats[k]),
        bar: { value: d.stats[k], max: k === 'hp' ? sc.hp : sc.other }, eff: String(ev === 'points' ? d.points[k] : d.evs[k]), iv: String(ivOf(m, k)), live: md === 'iv' ? 'iv' : 'eff' });
    }
    out.push({ id: 'hp', kind: 'item', label: 'HIDDEN POWER', value: d.hiddenPower.type, type: d.hiddenPower.typeId, power: String(d.hiddenPower.power) });
    out.push({ id: 'actions', kind: 'button', label: 'QUICK ACTIONS' });
    return out.concat(undoRows(X));
  }
  function setMode(dir) {
    const ms = modes(), next = ms[(Math.max(0, ms.indexOf(mode())) + dir + ms.length) % ms.length];
    ivMode = next === 'iv';
    if (!ivMode && !R().points) X.setPref('statsView', next);          // (a team whose rules force the points view does not change what the viewer chose for the others)
    return [];
  }
  /** One press of left / right on a stat: one step of the number being edited. The run's steps share a coalesce key: ONE undo step. */
  function step(k, dir) {
    const m = mon(), d = derived(), md = mode(), key = 'spin:' + m.id + ':' + k + ':' + md;
    if (md === 'iv') {
      const cur = m.iv[k];
      if (R().iv.fixed === null && dir < 0 && cur <= R().iv.min) return [];          // (already at the bottom: nothing to say; under rules that fix the IVs the reducer says so)
      X.dispatch({ type: 'ivSet', monId: m.id, stat: k, value: cur + dir, coalesce: key });
      return [];
    }
    const cur = md === 'points' ? d.points[k] : d.evs[k];
    if (dir < 0 && cur <= 0) return [];
    // EVs move on the grid of four (an odd value from an import steps onto it); points one at a time
    const value = md === 'points' ? cur + dir : dir > 0 ? Math.floor(cur / STEP.ev) * STEP.ev + STEP.ev : Math.ceil(cur / STEP.ev) * STEP.ev - STEP.ev;
    X.dispatch({ type: 'evSet', monId: m.id, stat: k, value, mode: md, coalesce: key });
    return [];
  }
  /** A on a stat: the numbers pop-up for the number being edited. */
  function number(k) {
    const m = mon(), md = mode(), b = budgets(), id = m.id;
    const now = () => { const mm = mon(), d = derived(); return md === 'iv' ? mm.iv[k] : md === 'points' ? d.points[k] : d.evs[k]; };
    if (md === 'iv') return numberMenu(X, { id: 'iv:' + k, label: LONG[k].toUpperCase() + ' IV', name: LONG[k] + ' IV', what: 'the ' + LONG[k] + ' IV', get: now, min: R().iv.min, max: R().iv.max, jumps: JUMPS.iv, set: (v) => X.dispatch({ type: 'ivSet', monId: id, stat: k, value: v }) });
    const points = md === 'points';
    return numberMenu(X, { id: md + ':' + k, label: LONG[k].toUpperCase() + (points ? ' POINTS' : ' EV'), name: LONG[k], what: 'the ' + LONG[k] + (points ? ' stat points' : ' EVs'), get: now, min: 0, max: points ? (b ? b.pointsPerStat : 32) : R().ev.perStat, jumps: JUMPS[md],
      set: (v) => X.dispatch({ type: 'evSet', monId: id, stat: k, value: v, mode: md }) });
  }
  function hiddenPower() {
    const d = derived(), id = mon().id, types = kit().HP_TYPES;
    X.popup.open({
      id: 'hidden-power', title: 'HIDDEN POWER', cursor: Math.max(0, types.findIndex((t) => t.id === d.hiddenPower.typeId)),
      rows: () => types.map((t) => ({ id: 'hp:' + t.name, label: t.name.toUpperCase() })),
      help: (r) => ['Set the IVs for Hidden Power', r.label + ' (each IV 30 or 31).'],
      pick(res) { if (res.kind === 'choose') X.dispatch({ type: 'ivPreset', monId: id, preset: res.row.id }); return []; },
    });
    return [];
  }
  function actions() {
    const id = mon().id;
    X.popup.open({
      id: 'quick', title: 'QUICK ACTIONS',
      rows: () => QUICK.map((q) => ({ id: q.id, label: q.label })),
      help: (r) => (QUICK.find((q) => q.id === r.id) || {}).help,
      pick(res) { const q = res.kind === 'choose' ? QUICK.find((x) => x.id === res.row.id) : null; if (q) X.dispatch({ ...q.action, monId: id }); return []; },
    });
    return [];
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return X.back();
    if (r.kind === 'change' && r.row.id === 'edit') return setMode(r.dir);
    if (r.kind !== 'choose' && r.kind !== 'refused') return [];
    if (isUndoRow(r.row.id)) return undoAct(X, r.row.id);          // (a grey one says there is nothing to undo)
    if (r.row.id === 'hp') return hiddenPower();
    if (r.row.id === 'actions') return actions();
    return [];
  }
  function helpOf(row) {
    if (!row) return ['', ''];
    if (isUndoRow(row.id)) return undoHelp(X, row.id);
    const d = derived(), b = budgets(), md = mode();
    if (!d.ok) return 'This ROM has no Pok{E}mon with that number, so there are no stats to show.';
    if (row.id === 'edit') {
      if (md === 'iv') return R().iv.fixed !== null ? ['These rules fix every IV at ' + R().iv.fixed + '.', ''] : ['IVs: ' + R().iv.min + ' to ' + R().iv.max + ' for each stat.', 'Left and right on a stat change it.'];
      if (md === 'points') return 'One stat point adds 1 to a stat at level 50. A stat takes up to ' + (b ? b.pointsPerStat : 32) + '.' + (b && !b.pointsBinding ? ' The ' + b.points.total + ' is the Champions limit, advisory here: the EV cap decides.' : '');
      return ['Every 4 EVs add 1 to a stat before', 'level scaling. A stat takes up to ' + R().ev.perStat + '.'];
    }
    if (row.stat) {
      const nat = d.nature ? d.nature.name : '';
      return [LONG[row.stat] + ' ' + row.value + (row.nat > 0 ? ', raised by ' + nat : row.nat < 0 ? ', lowered by ' + nat : '') + '.', (effView() === 'points' ? 'Points ' : 'EV ') + row.eff + ', IV ' + row.iv + '. A: type, max, jump.'];
    }
    if (row.id === 'hp') return 'Hidden Power is ' + d.hiddenPower.type + ', power ' + d.hiddenPower.power + ' (the ROM move table\'s fixed power). Its type comes from the IVs: A sets them for a type.';
    if (row.id === 'actions') return ['Reset or snap the EVs,', 'or set every IV at once.'];
    return ['', ''];
  }
  function sayOf(row) {
    if (!row) return '';
    if (row.id === 'edit') return 'Editing ' + (row.value === 'EVS' ? 'EVs' : row.value === 'IVS' ? 'IVs' : 'stat points') + '. ' + (row.budget ? row.budget.say : '');
    if (row.stat) return LONG[row.stat] + ' ' + row.value + (row.nat > 0 ? ', raised by the nature' : row.nat < 0 ? ', lowered by the nature' : '') + ', ' + (effView() === 'points' ? 'points ' : 'EV ') + row.eff + ', IV ' + row.iv + '.';
    if (row.id === 'hp') return 'Hidden Power ' + row.value + ', power ' + row.power + '.';
    return row.label + '.';
  }
  return {
    enter() { const id = X.at().monId; if (id !== shown) { shown = id; ivMode = false; list.set(0); } },
    press(action, info) {
      const rs = rows(), row = rs[list.cursor(rs.length)];
      if ((action === 'start' || action === 'x') && derived().ok) return actions();
      if (row && row.stat) {
        if (action === 'left' || action === 'right') return step(row.stat, action === 'left' ? -1 : 1);
        if (action === 'a') return number(row.stat);
      }
      return act(list.press(action, rs, info));
    },
    pointer(ev) {
      const rs = rows();
      if (ev.kind === 'wheel' || ev.x === undefined || ev.x === null) { list.pointer(ev, rs); return []; }
      const h = list.hit(ev.x, ev.y, rs), row = h ? rs[h.index] : null;
      if (!row || !row.stat) return act(list.pointer(ev, rs));
      list.set(h.index, rs.length);
      if (ev.kind !== 'click') return [];
      const cells = statCells(h.index - list.state().offset), live = mode() === 'iv' ? 'iv' : 'eff';
      for (const name of ['eff', 'iv']) {
        const c = cells[name];
        if (!inR(c, ev.x, ev.y)) continue;
        if (name !== live) { ivMode = name === 'iv'; return []; }          // a tap on the OTHER number: that one is edited from now on
        return step(row.stat, ev.x < c.x + c.w / 2 ? -1 : 1);
      }
      return number(row.stat);                                             // a tap anywhere else on the row is A
    },
    hit: (x, y) => list.hit(x, y, rows()),
    rects: () => list.rects(rows()),
    state: () => ({ ...list.state(), mode: X.kit() && X.mon() ? mode() : 'ev' }),
    view() {
      const rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)];
      return {
        layout: 'stats', list: lv, mode: mode(),
        menu: { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.value === undefined ? {} : { value: r.value }), ...(r.disabled ? { disabled: true } : {}) })), cursor: lv.cursor },
        help: helpOf(row), pagesFirst: false, say: sayOf(row),
      };
    },
  };
}

export const FAMILY = Object.freeze({
  id: 'stats',
  screens: Object.freeze({}),
  ext: Object.freeze({ 'mon.tabs': [Object.freeze({ id: 'stats', label: 'STATS', create: statsTab })] }),
});
