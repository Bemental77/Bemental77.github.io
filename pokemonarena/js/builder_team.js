// pokemonarena/js/builder_team.js -- THE TEAM BUILDER, the TEAM family: one team, its rules and what the rules say about it.
//
//   builder-team    the team's six SLOTS (the ROM's party panels, two across) and a row of chips: RULES, CHECK, [a later stage's], MENU. A on a Pokemon opens its slot menu (EDIT, EARLIER, LATER,
//                   COPY, REMOVE); A on an empty slot opens the species picker to add one; MENU (the chip, START or X) opens the team menu (RENAME, SORT BY TYPE, CONVERT TO RULES, DUPLICATE, DELETE)
//   builder-rules   MODE (Standard / Level 5 / Level 100 / Champions), ITEM CLAUSE, DUPLICATES: left / right change the team's ruleset AT ONCE (teamRuleset: only the id changes, no Pokemon is edited)
//   builder-check   every problem the rules module finds, one row each; the message box has the reason, word-wrapped and paged (A turns its pages, then opens that Pokemon); CONVERT TO RULES
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. Screens of builder_hub.js (its header has the screen interface and what X is). Every edit is X.dispatch.
// REGISTRATION POINTS for later stages (X.ext): 'team.chips' (CODE, TEST: { id, label, help, run(X, team) -> effects }) and 'team.menu' (UNDO, REDO).

import { createList, plural, sentence } from './builder_parts.js';
import { BG, inR, clamp, slotRects, chipRects } from './builder_geom.js';

const SLOTS = 6, COLS = 2;
const extHelp = (X, slot, id) => { const e = X.ext(slot).find((x) => x.id === id); return e ? e.help || ['', ''] : null; };
const extRun = (X, slot, id, target) => { const e = X.ext(slot).find((x) => x.id === id); return e && typeof e.run === 'function' ? e.run(X, target) || [] : []; };

/* ================================================================================================ the team */
function teamScreen(X) {
  let cur = 0;                                                      // 0..5 = the slots (row * 2 + column), 6.. = the chips
  const ES = () => X.kit().ES;
  const team = () => X.team();
  const check = () => X.teamCheck(team().id);
  const maxMons = () => Math.min(X.rules(team().ruleset).team.max, SLOTS);
  const chips = () => [{ id: 'rules', label: 'RULES' }, { id: 'check', label: 'CHECK' }].concat(X.ext('team.chips').map((e) => ({ id: 'x:' + e.id, label: e.label })), [{ id: 'menu', label: 'MENU' }]);
  const count = () => SLOTS + chips().length;
  const fit = () => { cur = clamp(cur, 0, count() - 1); return cur; };
  const monAt = (i) => check().mons[i] || null;

  function addMon() {
    if (check().mons.length >= maxMons()) { X.flash('This team already has ' + check().mons.length + ' Pok{E}mon.', true); return []; }
    X.screen('builder-species').begin({ purpose: 'add' });
    return X.go('builder-species');
  }
  function edit(m) { X.setAt({ monId: m.id, tab: 'build' }); return X.go('builder-mon'); }
  const SLOT_HELP = { edit: ['Open this Pok{E}mon: species, level,', 'nature, ability, item.'], earlier: ['Move it one slot earlier.', 'The first slot leads in battle.'], later: ['Move it one slot later.', ''], copy: ['Add a copy of this Pok{E}mon', 'to the team.'], remove: ['Take it out of the team.', 'A asks first.'] };
  function slotMenu(i) {
    const m = monAt(i); if (!m) return [];
    const mid = m.id, tid = team().id, name = X.monName(m);
    const where = () => team().monIds.indexOf(mid);
    X.popup.open({
      id: 'slot', title: name,
      rows: () => [{ id: 'edit', label: 'EDIT' }, { id: 'earlier', label: 'EARLIER', stay: true }, { id: 'later', label: 'LATER', stay: true }, { id: 'copy', label: 'COPY' }, { id: 'remove', label: 'REMOVE' }],
      help: (r) => SLOT_HELP[r.id],
      pick(res) {
        if (res.kind !== 'choose' || where() < 0) return [];
        switch (res.row.id) {
          case 'edit': return edit(m);
          case 'earlier': X.dispatch({ type: 'monMove', teamId: tid, monId: mid, to: where() - 1 }); cur = Math.max(0, where()); return [];
          case 'later': X.dispatch({ type: 'monMove', teamId: tid, monId: mid, to: where() + 1 }); cur = Math.max(0, where()); return [];
          case 'copy': { const r = X.dispatch({ type: 'monDuplicate', teamId: tid, monId: mid }); if (r && !r.error) cur = Math.max(0, where() + 1); return []; }
          default: X.ask({ id: 'remove-mon', text: 'Take ' + name + ' out of ' + team().name + '?' }, (v) => { if (v === 0) X.dispatch({ type: 'monRemove', teamId: tid, monId: mid }); return []; }); return [];
        }
      },
    });
    return [];
  }
  const MENU_HELP = {
    rename: ['Change the team\'s name', '(up to 16 characters).'], sort: ['Put the Pok{E}mon in type order.', 'The first slot leads in battle.'], conform: ['Fix levels, IVs, EVs, abilities, items', 'and illegal moves to fit the rules.'],
    duplicate: ['Make a copy of this team,', 'with copies of its Pok{E}mon.'], delete: ['Delete this team and its', 'Pok{E}mon. A asks first.'],
  };
  function teamMenu() {
    const tid = team().id;
    X.popup.open({
      id: 'team', title: team().name,
      rows: () => [{ id: 'rename', label: 'RENAME' }, { id: 'sort', label: 'SORT BY TYPE' }, { id: 'conform', label: 'CONVERT TO RULES' }, { id: 'duplicate', label: 'DUPLICATE' }]
        .concat(X.ext('team.menu').map((e) => ({ id: 'x:' + e.id, label: e.label })), [{ id: 'delete', label: 'DELETE' }]),
      help: (r) => MENU_HELP[r.id] || extHelp(X, 'team.menu', r.id.slice(2)),
      pick(res) {
        const t = team();
        if (res.kind !== 'choose' || !t) return [];
        switch (res.row.id) {
          case 'rename':
            X.entry.open({ id: 'team', title: 'TEAM NAME?', value: t.name, max: X.kit().LIMITS.teamName, charset: 'name' }, (r) => { if (r.ok && r.value.trim()) X.dispatch({ type: 'teamRename', teamId: tid, name: r.value.trim() }); return []; });
            return [];
          case 'sort': X.dispatch({ type: 'teamSort', teamId: tid, by: 'type' }); return [];
          case 'conform': X.dispatch({ type: 'teamConform', teamId: tid }); return [];
          case 'duplicate': { const r = X.dispatch({ type: 'teamDuplicate', teamId: tid }); if (r && !r.error && r.result) { const c = ES().findTeam(r.profile, r.result.teamId); X.flash('Copied as ' + (c ? c.name : 'a new team') + '.'); } return []; }
          case 'delete':
            X.ask({ id: 'del-team', text: 'Delete "' + t.name + '"' + (t.monIds.length ? ' and its ' + t.monIds.length + ' Pok{E}mon?' : '?') }, (v) => { if (v !== 0) return []; const r = X.dispatch({ type: 'teamDelete', teamId: tid }); return r && !r.error ? X.go('builder-teams') : []; });
            return [];
          default: return extRun(X, 'team.menu', res.row.id.slice(2), t);
        }
      },
    });
    return [];
  }
  function chip(id) {
    switch (id) {
      case 'rules': return X.go('builder-rules');
      case 'check': X.screen('builder-check').begin(null); return X.go('builder-check');
      case 'menu': return teamMenu();
      default: return extRun(X, 'team.chips', id.slice(2), team());
    }
  }
  function activate() {
    fit();
    if (cur >= SLOTS) return chip(chips()[cur - SLOTS].id);
    return monAt(cur) ? slotMenu(cur) : addMon();
  }
  // the d-pad on two columns of three slots over a row of chips: the chip under a column is the nearest one, and up from a chip returns to the column above it
  function move(action) {
    const nc = chips().length;
    if (cur < SLOTS) {
      const r = Math.floor(cur / COLS), c = cur % COLS;
      if (action === 'left' || action === 'right') cur = r * COLS + (c ^ 1);
      else if (action === 'up') cur = r === 0 ? SLOTS + Math.min(nc - 1, Math.round(c * (nc - 1))) : cur - COLS;
      else cur = r === 2 ? SLOTS + Math.min(nc - 1, Math.round(c * (nc - 1))) : cur + COLS;
    } else {
      const k = cur - SLOTS;
      if (action === 'left') cur = SLOTS + (k + nc - 1) % nc;
      else if (action === 'right') cur = SLOTS + (k + 1) % nc;
      else { const col = nc > 1 && k >= nc / 2 ? 1 : 0; cur = (action === 'up' ? 2 : 0) * COLS + col; }
    }
  }
  function hit(x, y) {
    const sr = slotRects();
    for (let i = 0; i < SLOTS; i++) if (inR(sr[i], x, y)) return { kind: 'slot', index: i };
    const cr = chipRects(chips().length);
    for (let i = 0; i < cr.length; i++) if (inR(cr[i], x, y)) return { kind: 'chip', index: SLOTS + i };
    return null;
  }
  function slotView(i) {
    const m = monAt(i), c = check();
    if (!m) return { empty: true, add: i === c.mons.length && i < maxMons() };
    const sp = X.kit().pack.species[m.species], n = (c.v.mons[i] || []).length;
    return { empty: false, species: m.species, known: !!sp, shiny: !!m.shiny, name: X.monName(m), level: m.level, gender: m.gender === 'M' || m.gender === 'F' ? m.gender : '', problems: n };
  }
  function helpOf() {
    const c = check(), t = team();
    if (cur < SLOTS) {
      const m = monAt(cur);
      if (!m) return cur < maxMons() ? ['An empty slot.', 'A chooses a Pok{E}mon to add.'] : ['These rules allow ' + plural(maxMons(), 'Pok{E}mon', 'Pok{E}mon') + '.', ''];
      const d = X.kit().ED.derived(X.kit().pack, m, t.ruleset), n = (c.v.mons[cur] || []).length;
      return [X.speciesName(m.species) + ', Lv ' + m.level + (d.ok && d.level !== m.level ? ' (fights at Lv ' + d.level + ')' : '') + '.', n ? plural(n, 'problem') + ': CHECK lists ' + (n === 1 ? 'it' : 'them') + '.' : 'It passes the rules. A opens its menu.'];
    }
    const id = chips()[cur - SLOTS].id;
    if (id === 'rules') return ES().rulesetLabel(t.ruleset) + '. A changes the rules.';
    if (id === 'check') return c.status === 'empty' ? ['Add a Pok{E}mon to check the team.', ''] : c.status === 'legal' ? ['Every Pok{E}mon passes the rules.', 'A lists what was checked.'] : [plural(c.count, 'problem') + ' under these rules.', 'A lists them.'];
    if (id === 'menu') return ['Rename, sort, convert to the', 'rules, duplicate or delete the team.'];
    return extHelp(X, 'team.chips', id.slice(2)) || ['', ''];
  }
  return {
    // (back from a Pokemon, or from the picker that added one: the cursor is on its slot. Back from RULES or CHECK it stays on the chip it left from)
    enter() { const at = X.at(), t = team(); if (t && at.monId && cur < SLOTS) { const i = t.monIds.indexOf(at.monId); if (i >= 0) cur = i; } fit(); },
    onEditor() { cur = 0; },
    press(action) {
      fit();
      switch (action) {
        case 'up': case 'down': case 'left': case 'right': move(action); return [];
        case 'a': return activate();
        case 'b': return X.back();
        case 'start': case 'x': return teamMenu();
        default: return [];
      }
    },
    pointer(ev) {
      if (ev.kind === 'wheel') return [];
      const h = ev.x === undefined || ev.x === null ? null : hit(ev.x, ev.y);
      if (!h) return [];
      cur = h.index;
      return ev.kind === 'click' ? activate() : [];
    },
    hit,
    rects: () => slotRects().concat(chipRects(chips().length)),
    state: () => ({ cursor: cur }),
    view() {
      fit();
      const t = team(), c = check(), cs = chips(), cr = chipRects(cs.length);
      return {
        kind: 'team', title: t.name, status: { text: X.statusWords(c).toUpperCase(), bad: c.status === 'bad' }, cursor: cur,
        slots: Array.from({ length: SLOTS }, (_, i) => slotView(i)), chips: cs.map((ch, i) => ({ id: ch.id, label: ch.label, x: cr[i].x, y: cr[i].y, w: cr[i].w, h: cr[i].h })),
        help: helpOf(), say: 'Team ' + t.name + ', ' + X.statusWords(c) + '. ' + (cur < SLOTS ? 'Slot ' + (cur + 1) + ': ' + (monAt(cur) ? X.monName(monAt(cur)) : 'empty') + '.' : cs[cur - SLOTS].label + '.'),
      };
    },
  };
}

/* ================================================================================================ the rules */
const MODE_SHOWN = Object.freeze({ standard: 'STANDARD', lv5: 'LEVEL 5', lv100: 'LEVEL 100', 'strict-champions': 'CHAMPIONS' });
const MODE_HELP = Object.freeze({ standard: ['Standard: battles at Lv 50,', '510 EVs.'], lv5: ['Level 5 battles.', ''], lv100: ['Level 100 battles.', ''], 'strict-champions': ['Champions: Lv 50, IV 31,', 'stat points (66).'] });
function rulesScreen(X) {
  const list = createList(BG.list);
  const ES = () => X.kit().ES;
  const parsed = () => { try { return ES().parseRulesetId(X.team().ruleset); } catch (_e) { return { mode: 'standard', itemClause: false, noSpeciesClause: false, unknown: [] }; } };
  function rows() {
    const p = parsed();
    return [
      { id: 'mode', kind: 'choice', label: 'MODE', value: MODE_SHOWN[p.mode] },
      { id: 'item', kind: 'choice', label: 'ITEM CLAUSE', value: p.itemClause ? 'ON' : 'OFF' },
      { id: 'dupes', kind: 'choice', label: 'DUPLICATES', value: p.noSpeciesClause ? 'ON' : 'OFF' },
      { id: 'back', kind: 'button', label: 'BACK' },
    ];
  }
  function change(row, dir) {
    const p = parsed(), modes = ES().LEVEL_MODES, patch = {};
    if (row.id === 'mode') patch.mode = modes[(modes.indexOf(p.mode) + dir + modes.length) % modes.length];
    else if (row.id === 'item') patch.itemClause = !p.itemClause;
    else patch.noSpeciesClause = !p.noSpeciesClause;
    let ruleset;
    try { ruleset = ES().buildRulesetId({ ...p, keep: p.unknown, ...patch }); } catch (e) { X.flash(String(e && e.message ? e.message : e), true); return []; }
    X.dispatch({ type: 'teamRuleset', teamId: X.team().id, ruleset });
    return [];
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back' || (r.kind === 'choose' && r.row.id === 'back')) return X.back();
    if (r.kind === 'change') return change(r.row, r.dir);
    return [];
  }
  function helpOf(row) {
    const p = parsed();
    switch (row && row.id) {
      case 'mode': return MODE_HELP[p.mode];
      case 'item': return ['Item clause: no two Pok{E}mon', 'hold the same item.'];
      case 'dupes': return ['Allow two of the same', 'Pok{E}dex number.'];
      default: return ['Back to the team.', ''];
    }
  }
  return {
    press: (action, info) => act(list.press(action, rows(), info)),
    pointer: (ev) => act(list.pointer(ev, rows())),
    hit: (x, y) => list.hit(x, y, rows()),
    rects: () => list.rects(rows()),
    state: () => list.state(),
    view() {
      const t = X.team(), rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)], c = X.teamCheck(t.id);
      return {
        kind: 'rules', title: 'RULES: ' + t.name, list: lv, menu: { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.value === undefined ? {} : { value: r.value }) })), cursor: lv.cursor },
        side: { label: ES().rulesetLabel(t.ruleset), status: X.statusWords(c).toUpperCase(), bad: c.status === 'bad' },
        help: helpOf(row), say: 'Rules of ' + t.name + '. ' + (row ? row.label + (row.value !== undefined ? ' ' + row.value : '') + '.' : ''),
      };
    },
  };
}

/* ================================================================================================ the check */
function checkScreen(X) {
  const list = createList(BG.wide);
  let wantMon = null;                                               // the Pokemon whose first problem the cursor starts on (the Pokemon screen's PROBLEMS row)
  function rows() {
    const c = X.teamCheck(X.team().id), out = [];
    if (c.status === 'empty') return [{ id: 'back', kind: 'button', label: 'BACK' }];          // (nothing to judge yet: the screen says to add a Pokemon)
    c.v.team.forEach((p, i) => out.push({ id: 'tp:' + i, kind: 'item', label: 'TEAM', value: p.label, text: sentence(p.text) }));
    c.v.mons.forEach((ps, mi) => ps.forEach((p, pi) => out.push({ id: 'mp:' + mi + ':' + pi, kind: 'item', label: (mi + 1) + ' ' + X.monName(c.mons[mi]), value: p.label, text: sentence(p.text), monId: c.mons[mi].id })));
    if (out.length) out.push({ id: 'conform', kind: 'button', label: 'CONVERT TO RULES' });
    out.push({ id: 'back', kind: 'button', label: 'BACK' });
    return out;
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return X.back();
    if (r.kind !== 'choose') return [];
    if (r.row.monId) { X.setAt({ monId: r.row.monId, tab: 'build' }); return X.go('builder-mon'); }
    if (r.row.id === 'conform') { X.dispatch({ type: 'teamConform', teamId: X.team().id }); return []; }
    if (r.row.id === 'back') return X.back();
    return [];
  }
  function helpOf(row, c) {
    if (row && row.text) return row.text;
    if (row && row.id === 'conform') return ['Fix levels, IVs, EVs, abilities, items', 'and illegal moves to fit the rules.'];
    if (c.status === 'empty') return ['Add a Pok{E}mon to check it.', ''];
    if (c.status === 'legal') return 'Yes. Every Pok{E}mon passes ' + X.kit().ES.rulesetLabel(X.team().ruleset) + '.';
    return ['Back to the team.', ''];
  }
  return {
    /** Say where the cursor starts: on the first problem of this Pokemon (null: at the top). */
    begin(monId) { wantMon = monId || null; },
    enter() { const rs = rows(); if (!(wantMon && list.seek(rs, (r) => r.monId === wantMon))) list.set(0, rs.length); wantMon = null; },
    press: (action, info) => act(list.press(action, rows(), info)),
    pointer: (ev) => act(list.pointer(ev, rows())),
    hit: (x, y) => list.hit(x, y, rows()),
    rects: () => list.rects(rows()),
    state: () => list.state(),
    view() {
      const t = X.team(), c = X.teamCheck(t.id), rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)];
      return {
        kind: 'check', title: 'CHECK: ' + X.statusWords(c).toUpperCase(), list: lv,
        menu: { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label })), cursor: lv.cursor },
        help: helpOf(row, c), pagesFirst: !!(row && row.text),
        say: 'Check of ' + t.name + ', ' + X.statusWords(c) + '. ' + (row ? row.label + (row.value ? ', ' + row.value : '') + '.' : ''),
      };
    },
  };
}

export const FAMILY = Object.freeze({
  id: 'team',
  screens: Object.freeze({
    'builder-team': Object.freeze({ parent: 'builder-teams', title: 'Team Builder: Team', need: 'team', create: teamScreen }),
    'builder-rules': Object.freeze({ parent: 'builder-team', title: 'Team Builder: Rules', need: 'team', create: rulesScreen }),
    'builder-check': Object.freeze({ parent: 'builder-team', title: 'Team Builder: Check', need: 'team', create: checkScreen }),
  }),
});
