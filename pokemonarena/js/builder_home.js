// pokemonarena/js/builder_home.js -- THE TEAM BUILDER, the HOME family: the two lists a player starts from.
//
//   builder         TRAINERS   every profile in this browser (the one being edited is marked ACTIVE), NEW TRAINER, BACK. A opens a trainer (switches to it and shows its teams); NEW TRAINER opens
//                              the trainer app's NEW TRAINER screens (trainer-new: ONE way to make a trainer, INAPP.md TRAINER decision 4; B or the last step comes back here); MENU
//                              (the chip, RIGHT, START or X) opens the trainer's menu: OPEN, RENAME, DELETE, and for the trainer being edited PORTRAIT, UNDO, REDO
//   builder-teams   TEAMS      the trainer's teams (16 at most), NEW TEAM, IMPORT A CODE, UNDO, REDO, REMOVE UNUSED (only when the box holds Pokemon that are on no team), BACK. A opens a
//                              team; MENU opens the team's menu: OPEN, RENAME, DUPLICATE, MOVE UP, MOVE DOWN, DELETE
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. A screen of builder_hub.js (its header has the screen interface and what X is).
// Team edits go through X.dispatch (the reducer); what touches the STORE (open, rename another, delete a profile) is an effect for builder_ctl.js. A trainer is MADE by the trainer app.
// REGISTRATION POINTS (X.ext): 'trainers.rows' (IMPORT PROFILE, IMPORT SAVE, DATA), 'trainers.menu' (PORTRAIT, UNDO, REDO; later EXPORT, IDENTITY KEY), 'teams.rows' (IMPORT A CODE, UNDO, REDO),
// 'teams.menu'. An entry: builder_parts.js "AN EXTENSION ENTRY"; `target` is the trainer or the team the menu was opened on (null for a list's rows).

import { createList, plural, extRows, extRun, extHelp } from './builder_parts.js';
import { BG, inR } from './builder_geom.js';

const CHIP = BG.strip.chip;
const menuRow = (lv) => ({ rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.disabled ? { disabled: true } : {}) })), cursor: lv.cursor });

/* ================================================================================================ TRAINERS */
function trainersScreen(X) {
  const list = createList(BG.list);
  const byId = (id) => X.trainers().find((t) => t.id === id) || null;
  function rows() {
    const active = X.activeId();
    const out = X.trainers().map((t) => ({ id: 'p:' + t.id, kind: 'item', label: t.unreadable ? '(unreadable)' : t.name, pid: t.id, tag: t.id === active ? 'ACTIVE' : t.readOnly ? 'LOCKED' : '', ...(t.unreadable ? { disabled: true } : {}) }));
    return out.concat(extRows(X, 'trainers.rows', null, 'button'), [{ id: 'new', kind: 'button', label: 'NEW TRAINER' }, { id: 'back', kind: 'button', label: 'BACK' }]);
  }
  const rowNow = () => { const rs = rows(); return rs[list.cursor(rs.length)] || null; };
  const open = (id) => (id === X.activeId() ? X.go('builder-teams') : [X.eff('profile-open', { id })]);
  const nameMax = () => X.kit().LIMITS.trainerName;

  // ONE WAY TO MAKE A TRAINER: the trainer app's NEW TRAINER screens, opened on top of this list (they come back here; the builder then opens the trainer made: builder_hub.js onData)
  const newTrainer = () => X.go('trainer-new');
  function rename(t) {
    X.entry.open({ id: 'trainer', title: 'NEW NAME?', value: t.name, max: nameMax(), charset: 'name' }, (r) => {
      const name = r.ok ? r.value.trim() : '';
      if (!name || name === t.name) return [];
      if (t.id === X.activeId()) { X.dispatch({ type: 'rename', name }); return []; }          // the profile being edited: the reducer (and its words when it refuses)
      return [X.eff('profile-rename', { id: t.id, name })];                                    // another one: the store's, so the ctl's
    });
    return [];
  }
  function remove(t) {
    X.ask({ id: 'del-trainer', text: '"' + t.name + '" and all of its teams and Pok{E}mon will be removed from this browser. This cannot be undone.' }, (v) => (v === 0 ? [X.eff('profile-delete', { id: t.id })] : []));
    return [];
  }
  const MENU_HELP = { open: ['Show this trainer\'s teams.', ''], rename: ['Change the trainer\'s name', '(up to 10 characters).'], delete: ['Remove this trainer and', 'everything it holds. A asks first.'] };
  function openMenu() {
    const row = rowNow(), t = row && row.pid ? byId(row.pid) : null;
    if (!t || t.unreadable) return [];
    X.popup.open({
      id: 'trainer', title: t.name,
      rows: () => [{ id: 'open', label: 'OPEN' }, { id: 'rename', label: 'RENAME' }].concat(extRows(X, 'trainers.menu', t), [{ id: 'delete', label: 'DELETE' }]),
      help: (r) => MENU_HELP[r.id] || extHelp(X, 'trainers.menu', r.id, t),
      pick(res) {
        if (res.kind === 'refused') return extRun(X, 'trainers.menu', res.row.id, t);          // (a grey row: its reason goes to the message box)
        if (res.kind !== 'choose') return [];
        switch (res.row.id) {
          case 'open': return open(t.id);
          case 'rename': return rename(t);
          case 'delete': return remove(t);
          default: return extRun(X, 'trainers.menu', res.row.id, t);
        }
      },
    });
    return [];
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return X.back();
    if (r.kind === 'refused' && r.row.ext) return extRun(X, 'trainers.rows', r.row.id, null);
    if (r.kind !== 'choose') return [];
    if (r.row.pid) return open(r.row.pid);
    if (r.row.id === 'new') return newTrainer();
    if (r.row.id === 'back') return X.back();
    return extRun(X, 'trainers.rows', r.row.id, null);
  }
  function helpOf(row, t) {
    if (!row) return ['', ''];
    if (row.pid) {
      if (!t || t.unreadable) return ['This profile could not be read.', ''];
      return [plural(t.teams, 'team') + ', ' + t.mons + ' Pok{E}mon.', t.readOnly ? 'Read-only: a newer version saved it.' : t.id === X.activeId() ? 'A opens the teams.' : 'A switches to this trainer.'];
    }
    if (row.id === 'new') return X.trainers().length ? ['Make another trainer profile.', 'Each one keeps its own teams.'] : ['No trainer yet. A trainer keeps', 'your teams in this browser.'];
    if (row.id === 'back') return ['Back to the main menu.', ''];
    return extHelp(X, 'trainers.rows', row.id) || ['', ''];
  }
  return {
    /** A profile was loaded (or dropped): the cursor goes to the trainer being edited. */
    onEditor() { const id = X.activeId(); if (id) list.seek(rows(), (r) => r.pid === id); },
    press(action, info) {
      if (action === 'start' || action === 'x' || action === 'right') return openMenu();
      return act(list.press(action, rows(), info));
    },
    pointer(ev) {
      if (ev.kind === 'click' && inR(CHIP, ev.x, ev.y)) return openMenu();
      return act(list.pointer(ev, rows()));
    },
    hit(x, y) { const r = rowNow(); return inR(CHIP, x, y) ? (r && r.pid ? { kind: 'chip', id: 'menu' } : null) : list.hit(x, y, rows()); },
    rects: () => list.rects(rows()).concat([{ ...CHIP, id: 'menu' }]),
    state: () => list.state(),
    view() {
      const rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)] || null, t = row && row.pid ? byId(row.pid) : null;
      return {
        kind: 'trainers', title: 'TRAINERS', chips: [{ id: 'menu', label: 'MENU', x: CHIP.x, y: CHIP.y, w: CHIP.w, h: CHIP.h, off: !t || !!t.unreadable }], list: lv, menu: menuRow(lv),
        side: t && !t.unreadable ? { avatar: t.avatar, name: t.name, lines: [plural(t.teams, 'TEAM', 'TEAMS'), t.mons + ' POK{E}MON'] } : { avatar: null, name: '', lines: [] },
        help: helpOf(row, t), say: 'Team Builder, trainers. ' + (row ? row.label + (row.tag ? ', ' + row.tag.toLowerCase() : '') + '.' : ''),
      };
    },
  };
}

/* ================================================================================================ TEAMS */
function teamsScreen(X) {
  const list = createList(BG.list);
  const ES = () => X.kit().ES;
  const teams = () => X.profile().teams;
  const full = () => teams().length >= ES().EDITOR_LIMITS.teamsMax;
  const unused = () => X.memo('unused', () => ES().unusedMons(X.profile()).length);
  const tagOf = (c) => (c.status === 'empty' ? '--' : c.status === 'legal' ? 'OK' : '!' + Math.min(c.count, 99));
  function rows() {
    const out = teams().map((t) => { const c = X.teamCheck(t.id); return { id: 't:' + t.id, kind: 'item', label: t.name, tid: t.id, tag: tagOf(c), bad: c.status === 'bad' }; });
    out.push({ id: 'new', kind: 'button', label: full() ? 'TEAM LIMIT REACHED' : 'NEW TEAM', ...(full() ? { disabled: true } : {}) });
    out.push(...extRows(X, 'teams.rows', null, 'button'));
    if (unused() > 0) out.push({ id: 'unused', kind: 'button', label: 'REMOVE UNUSED' });
    out.push({ id: 'back', kind: 'button', label: 'BACK' });
    return out;
  }
  const rowNow = () => { const rs = rows(); return rs[list.cursor(rs.length)] || null; };
  const seek = (teamId) => list.seek(rows(), (r) => r.tid === teamId);
  function openTeam(id) { X.setAt({ teamId: id, monId: null, tab: 'build' }); return X.go('builder-team'); }
  function newTeam() {
    const r = X.dispatch({ type: 'teamCreate' });
    if (!r || r.error || !r.result) return [];
    seek(r.result.teamId);
    return openTeam(r.result.teamId);
  }
  function rename(t) {
    X.entry.open({ id: 'team', title: 'TEAM NAME?', value: t.name, max: X.kit().LIMITS.teamName, charset: 'name' }, (r) => { if (r.ok && r.value.trim()) X.dispatch({ type: 'teamRename', teamId: t.id, name: r.value.trim() }); return []; });
    return [];
  }
  function remove(t) {
    const n = t.monIds.length;
    X.ask({ id: 'del-team', text: 'Delete "' + t.name + '"' + (n ? ' and its ' + n + ' Pok{E}mon?' : '?') }, (v) => { if (v === 0) X.dispatch({ type: 'teamDelete', teamId: t.id }); return []; });
    return [];
  }
  const MENU_HELP = {
    open: ['Open this team: its six slots,', 'its rules and its check.'], rename: ['Change the team\'s name', '(up to 16 characters).'], duplicate: ['Make a copy of this team,', 'with copies of its Pok{E}mon.'],
    up: ['Move this team one place up', 'the list.'], down: ['Move this team one place down', 'the list.'], delete: ['Delete this team and its', 'Pok{E}mon. A asks first.'],
  };
  function openMenu() {
    const row = rowNow();
    if (!row || !row.tid) return [];
    const tid = row.tid, find = () => ES().findTeam(X.profile(), tid);
    X.popup.open({
      id: 'teams', title: row.label,
      rows: () => [{ id: 'open', label: 'OPEN' }, { id: 'rename', label: 'RENAME' }, { id: 'duplicate', label: 'DUPLICATE' }, { id: 'up', label: 'MOVE UP', stay: true }, { id: 'down', label: 'MOVE DOWN', stay: true }]
        .concat(extRows(X, 'teams.menu', find()), [{ id: 'delete', label: 'DELETE' }]),
      help: (r) => MENU_HELP[r.id] || extHelp(X, 'teams.menu', r.id, find()),
      pick(res) {
        const t = find();
        if (res.kind === 'refused' && t) return extRun(X, 'teams.menu', res.row.id, t);
        if (res.kind !== 'choose' || !t) return [];
        const i = teams().indexOf(t);
        switch (res.row.id) {
          case 'open': return openTeam(tid);
          case 'rename': return rename(t);
          case 'duplicate': { const r = X.dispatch({ type: 'teamDuplicate', teamId: tid }); if (r && !r.error && r.result) seek(r.result.teamId); return []; }
          case 'up': X.dispatch({ type: 'teamMove', teamId: tid, to: i - 1 }); seek(tid); return [];
          case 'down': X.dispatch({ type: 'teamMove', teamId: tid, to: i + 1 }); seek(tid); return [];
          case 'delete': return remove(t);
          default: return extRun(X, 'teams.menu', res.row.id, t);
        }
      },
    });
    return [];
  }
  // a row another family put on the list (IMPORT A CODE, UNDO, REDO): it is run, and the cursor stays on it though the rows above it may have changed (an undo brought a team back)
  const extra = (row) => { const fx = extRun(X, 'teams.rows', row.id, null); list.seek(rows(), (x) => x.id === row.id); return fx; };
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return X.back();
    if (r.kind === 'refused') { if (r.row.id === 'new') X.flash('A profile holds at most ' + ES().EDITOR_LIMITS.teamsMax + ' teams.', true); else if (r.row.ext) return extra(r.row); return []; }
    if (r.kind !== 'choose') return [];
    if (r.row.tid) return openTeam(r.row.tid);
    switch (r.row.id) {
      case 'new': return newTeam();
      case 'unused': X.dispatch({ type: 'boxCleanup' }); return [];
      case 'back': return X.back();
      default: return extra(r.row);
    }
  }
  function helpOf(row) {
    if (!row) return ['', ''];
    if (row.tid) { const t = ES().findTeam(X.profile(), row.tid), c = X.teamCheck(row.tid); return ES().rulesetLabel(t.ruleset) + '. ' + X.statusWords(c) + '.'; }
    switch (row.id) {
      case 'new': return row.disabled ? ['A profile holds at most 16 teams.', 'Delete one to make room.'] : teams().length ? ['Make a new, empty team.', ''] : ['No team yet. Make one, then add', 'up to six Pok{E}mon to it.'];
      case 'unused': return [unused() + ' Pok{E}mon in the box are on no', 'team (from an import). A removes them.'];
      case 'back': return ['Back to the trainers.', ''];
      default: return extHelp(X, 'teams.rows', row.id) || ['', ''];
    }
  }
  return {
    enter() { const at = X.at(); if (at.teamId) seek(at.teamId); },
    press(action, info) {
      if (action === 'start' || action === 'x' || action === 'right') return openMenu();
      return act(list.press(action, rows(), info));
    },
    pointer(ev) {
      if (ev.kind === 'click' && inR(CHIP, ev.x, ev.y)) return openMenu();
      return act(list.pointer(ev, rows()));
    },
    hit(x, y) { const r = rowNow(); return inR(CHIP, x, y) ? (r && r.tid ? { kind: 'chip', id: 'menu' } : null) : list.hit(x, y, rows()); },
    rects: () => list.rects(rows()).concat([{ ...CHIP, id: 'menu' }]),
    state: () => list.state(),
    view() {
      const p = X.profile(), rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)] || null;
      const c = row && row.tid ? X.teamCheck(row.tid) : null;
      return {
        kind: 'teams', title: p.trainerName + ' TEAMS ' + teams().length + '/' + ES().EDITOR_LIMITS.teamsMax, chips: [{ id: 'menu', label: 'MENU', x: CHIP.x, y: CHIP.y, w: CHIP.w, h: CHIP.h, off: !c }], list: lv, menu: menuRow(lv),
        side: c ? { icons: c.mons.map((m) => ({ species: m.species, shiny: !!m.shiny })), lines: [c.mons.length ? plural(c.mons.length, 'POK{E}MON', 'POK{E}MON') : 'NO POK{E}MON YET', X.statusWords(c).toUpperCase()], bad: c.status === 'bad' } : { icons: [], lines: [], bad: false },
        help: helpOf(row), say: 'Team Builder, teams of ' + p.trainerName + '. ' + (row ? row.label + '.' : ''),
      };
    },
  };
}

export const FAMILY = Object.freeze({
  id: 'home',
  screens: Object.freeze({
    builder: Object.freeze({ parent: 'main', title: 'Team Builder', need: 'none', create: trainersScreen }),
    'builder-teams': Object.freeze({ parent: 'builder', title: 'Team Builder: Teams', need: 'profile', create: teamsScreen }),
  }),
});
