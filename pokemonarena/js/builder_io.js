// pokemonarena/js/builder_io.js -- THE TEAM BUILDER, what goes OUT of it and comes IN: the team code and the test battle.
//
//   builder-code   A TEAM CODE IS NEVER DRAWN AND NEVER TYPED KEY BY KEY (56 to 180 characters, with a glyph the ROM font lacks): it travels through the clipboard.
//                  COPY CODE     (when the screen was opened from a team: its CODE chip) the ctl makes the code and puts it on the clipboard; the message box says how many characters it
//                                is, or that the browser refused
//                  PASTE A CODE  the ctl reads the clipboard ON THAT PRESS: the way for a touch-only player. When the browser refuses, the picture says so and points at the next row
//                  ENTER A CODE  the text entry with the code's alphabet: Ctrl+V pastes into it, OK accepts
//                  A code that reads shows its PREVIEW: the team's name, its rules, its Pokemon (the ROM's party icons), whether it passes ITS OWN rules and the first reasons if not; then
//                  ADD AS A NEW TEAM (the reducer's teamImport, the DOM editor's) or CANCEL. A code that does not read is refused in words: teamcode.js's reason, or the rules module's
//   builder-test   THE TEST BATTLE: FORMAT (6v6, and 3v3 from three Pokemon), CPU (EASY / NORMAL / HARD), FOE (RANDOM, or another of this trainer's teams), START. START is refused in
//                  words while the team is empty or has problems (or the other team has); else the ctl saves, makes the codes and leaves for the battle page at the address the DOM
//                  editor built (editor_links.js battleUrl)
// The team screen gets two chips for them (CODE, TEST: 'team.chips'), the teams list a row (IMPORT A CODE: 'teams.rows').
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. Screens of builder_hub.js (its header has the screen interface and what X is). The clipboard, the
// code's compression and the navigation are the ctl's: this file returns effects ('code-length', 'code-copy', 'code-paste', 'code-decode', 'test-start') and hears the answers in tell(msg).

import { createList, plural, sentence } from './builder_parts.js';
import { BG } from './builder_geom.js';

/** The longest text a team code may be (teamcode.js MAX_CODE_CHARS): what the text entry takes. */
export const CODE_MAX = 1024;
const CPU_SHOWN = Object.freeze({ easy: 'EASY', normal: 'NORMAL', hard: 'HARD' });
const iconsOf = (mons) => mons.slice(0, 6).map((m) => ({ species: m.species, shiny: !!m.shiny }));
/** A reason of teamcode.js as the picture can write it: its own words, without the angle brackets the ROM font has no glyph for ("ARENA1.<payload>.<check>"). */
const drawable = (s) => String(s === undefined || s === null ? '' : s).replace(/[<>]/g, '');

/* ================================================================================================ the team code */
function codeScreen(X) {
  const list = createList(BG.list);
  // teamId: the team the screen was opened for (null: opened to bring a code IN); info: what the ctl said about that team's code; preview: a code that was read and not yet added
  const C = { teamId: null, info: null, preview: null };
  const ES = () => X.kit().ES;
  const team = () => (C.teamId ? ES().findTeam(X.profile(), C.teamId) : null);
  const fresh = () => (C.info && C.info.teamId === C.teamId && C.info.profile === X.profile() ? C.info : null);          // (what was said about the team as it is NOW: an edit makes it stale)
  function rows() {
    if (C.preview) return [{ id: 'add', kind: 'button', label: 'ADD AS A NEW TEAM' }, { id: 'cancel', kind: 'button', label: 'CANCEL' }];
    return (team() ? [{ id: 'copy', kind: 'button', label: 'COPY CODE' }] : []).concat([{ id: 'paste', kind: 'button', label: 'PASTE A CODE' }, { id: 'enter', kind: 'button', label: 'ENTER A CODE' }, { id: 'back', kind: 'button', label: 'BACK' }]);
  }
  function copy() {
    const t = team();
    if (!t.monIds.length) { X.flash('An empty team has no code. Add a Pok{E}mon first.', true); return []; }
    return [X.eff('code-copy', { teamId: t.id })];
  }
  function enterCode() {
    X.entry.open({ id: 'code', title: 'TEAM CODE? (CTRL+V)', value: '', max: CODE_MAX, charset: 'teamcode' }, (r) => (r.ok && r.value ? [X.eff('code-decode', { text: r.value })] : []));
    return [];
  }
  function add() {
    const r = X.dispatch({ type: 'teamImport', team: C.preview.team });
    if (!r || r.error || !r.result) return [];                                     // (the reducer said why: sixteen teams, a full box)
    C.preview = null;
    X.setAt({ teamId: r.result.teamId, monId: null, tab: 'build' });
    return X.go('builder-team', { replace: true });                                // the new team opens in this screen's place: B from it is the teams list
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') { if (C.preview) { C.preview = null; list.set(0); return []; } return X.back(); }
    if (r.kind !== 'choose') return [];
    switch (r.row.id) {
      case 'copy': return copy();
      case 'paste': return [X.eff('code-paste')];
      case 'enter': return enterCode();
      case 'add': return add();
      case 'cancel': C.preview = null; list.set(0); return [];
      default: return X.back();
    }
  }
  function previewHelp(p) {
    const label = ES().rulesetLabel(p.team.ruleset) + '. ';
    if (p.validation.ok) return label + 'Every Pok{E}mon passes the rules.';
    const first = p.validation.problems.map((x) => (x.mon === null ? 'Team' : 'Slot ' + (x.mon + 1)) + ', ' + x.label + ': ' + x.text).map(sentence).join(' ');
    return label + plural(p.validation.count, 'problem') + ' under its rules; it is added as it is and CHECK lists them. ' + first;
  }
  function helpOf(row) {
    if (C.preview) return row && row.id === 'cancel' ? ['Forget this code.', 'Nothing is added.'] : previewHelp(C.preview);
    const t = team(), info = fresh();
    switch (row && row.id) {
      case 'copy':
        if (!t.monIds.length) return ['An empty team has no code.', 'Add a Pok{E}mon first.'];
        if (info && info.error) return sentence(info.error);
        return [info ? 'This team as a code of ' + info.chars + ' characters.' : 'This team as a code.', 'A copies it to the clipboard.'];
      case 'paste': return ['Read a team code from the clipboard', 'and show what it holds.'];
      case 'enter': return ['Open a field for a team code:', 'Ctrl+V pastes into it, OK accepts.'];
      default: return ['Back to the ' + (t ? 'team.' : 'teams.'), ''];
    }
  }
  return {
    /** Say what the screen is opened for, BEFORE going to it: { teamId } (a team's CODE chip: COPY CODE is offered) or nothing (IMPORT A CODE). */
    begin(o) { C.teamId = o && typeof o.teamId === 'string' ? o.teamId : null; C.preview = null; C.info = null; list.set(0); },
    enter() {
      if (C.teamId && !team()) C.teamId = null;
      const t = team();
      if (t && t.monIds.length && !fresh()) X.emit(X.eff('code-length', { teamId: t.id }));          // (the ctl answers with how long the code is)
    },
    leave() { C.preview = null; },
    /** What the ctl answers (builder_ctl.js): the code's length, a copy made or refused, the clipboard refused or empty, a code decoded or refused. */
    tell(msg) {
      switch (msg && msg.type) {
        case 'length': C.info = { teamId: msg.teamId, profile: msg.of || X.profile(), ...(msg.error ? { error: String(msg.error) } : { chars: msg.chars | 0 }) }; return [];
        case 'copied': X.flash('Team code copied: ' + (msg.chars | 0) + ' characters. Paste it wherever you like.'); return [];
        case 'copy-refused': X.flash(msg.message ? sentence(msg.message) : 'This browser did not let the page copy. Try again right after a key press or a tap, or allow the clipboard for this site.', true); return [];
        case 'paste-refused': X.flash('This browser did not let the page read the clipboard. Use ENTER A CODE and paste there (Ctrl+V), or allow the clipboard for this site.', true); return [];
        case 'paste-empty': X.flash('The clipboard holds no text. Copy a team code first.', true); return [];
        case 'decoded':
          if (!msg.ok) { X.flash('That code cannot be used: ' + sentence(drawable(msg.message || msg.code || 'it could not be read')), true); return []; }
          C.preview = { team: msg.team, validation: msg.validation }; list.set(0);
          return [];
        default: return [];
      }
    },
    press: (action, info) => act(list.press(action, rows(), info)),
    pointer: (ev) => act(list.pointer(ev, rows())),
    hit: (x, y) => list.hit(x, y, rows()),
    rects: () => list.rects(rows()),
    state: () => ({ ...list.state(), teamId: C.teamId, preview: !!C.preview, chars: fresh() && fresh().chars ? fresh().chars : null }),
    view() {
      const rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)], p = C.preview, t = team();
      const menu = { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label })), cursor: lv.cursor };
      if (p) {
        const name = X.kit().text(p.team.name || '') || '(UNNAMED TEAM)', n = p.team.mons.length, bad = !p.validation.ok;
        return {
          kind: 'code', title: 'CODE: ' + name, list: lv, menu, pagesFirst: false,
          side: { icons: iconsOf(p.team.mons), lines: [plural(n, 'POK{E}MON', 'POK{E}MON'), bad ? plural(p.validation.count, 'PROBLEM', 'PROBLEMS') : 'LEGAL'], bad },
          help: helpOf(row), say: 'A team code was read: ' + name + ', ' + plural(n, 'Pok{E}mon', 'Pok{E}mon') + ', ' + (bad ? plural(p.validation.count, 'problem') : 'legal') + '. ' + (row ? row.label + '.' : ''),
        };
      }
      const c = t ? X.teamCheck(t.id) : null, info = fresh();
      return {
        kind: 'code', title: t ? 'CODE: ' + t.name : 'TEAM CODE', list: lv, menu, pagesFirst: false,
        side: c ? { icons: iconsOf(c.mons), lines: [info && info.chars ? info.chars + ' CHARACTERS' : c.mons.length ? plural(c.mons.length, 'POK{E}MON', 'POK{E}MON') : 'NO POK{E}MON YET', X.statusWords(c).toUpperCase()], bad: c.status === 'bad' } : { icons: [], lines: ['PASTE A CODE', 'TO ADD A TEAM'], bad: false },
        help: helpOf(row), say: 'Team code' + (t ? ' of ' + t.name : '') + '. ' + (row ? row.label + '.' : ''),
      };
    },
  };
}

/* ================================================================================================ the test battle */
function testScreen(X) {
  const list = createList(BG.wide);
  const T = { format: null, cpu: 'normal', foeId: null };
  const ES = () => X.kit().ES;
  const LINKS = () => X.kit().LINKS;
  const team = () => X.team();
  const check = () => X.teamCheck(team().id);
  const formats = () => LINKS().formatsForTeamSize(check().mons.length);
  const format = () => (T.format && formats().includes(T.format) ? T.format : LINKS().formatForTeamSize(check().mons.length));
  /** The other teams of this trainer that have Pokemon: who the test can be fought against. */
  const foes = () => X.profile().teams.filter((t) => t.id !== team().id && t.monIds.length > 0);
  const foe = () => (T.foeId ? foes().find((t) => t.id === T.foeId) || null : null);
  function rows() {
    const f = foe();
    return [
      { id: 'format', kind: 'choice', label: 'FORMAT', value: format() },
      { id: 'cpu', kind: 'choice', label: 'CPU', value: CPU_SHOWN[T.cpu] },
      { id: 'foe', kind: 'choice', label: 'FOE', value: f ? f.name : 'RANDOM' },
      { id: 'start', kind: 'button', label: 'START' },
      { id: 'back', kind: 'button', label: 'BACK' },
    ];
  }
  /** Why the battle cannot start, or null. The DOM editor's reasons. */
  function refusal() {
    const c = check(), f = foe();
    if (!c.mons.length) return 'Add a Pok{E}mon first.';
    if (c.status === 'bad') return 'Fix the ' + plural(c.count, 'problem') + ' first: CHECK lists ' + (c.count === 1 ? 'it' : 'them') + '.';
    if (f) { const fc = X.teamCheck(f.id); if (fc.status === 'bad') return '"' + f.name + '" has ' + plural(fc.count, 'problem') + '; fix ' + (fc.count === 1 ? 'it' : 'them') + ' first.'; }
    return null;
  }
  function change(row, dir) {
    if (row.id === 'format') { const fs = formats(); if (fs.length < 2) { X.flash('A team of fewer than three plays 6v6: every Pok{E}mon of both teams.'); return []; } T.format = fs[(fs.indexOf(format()) + dir + fs.length) % fs.length]; }
    else if (row.id === 'cpu') { const cs = LINKS().CPU_LEVELS; T.cpu = cs[(cs.indexOf(T.cpu) + dir + cs.length) % cs.length]; }
    else { const ids = [null].concat(foes().map((t) => t.id)); if (ids.length < 2) { X.flash('This trainer has no other team with Pok{E}mon: the foe is a random team.'); return []; } T.foeId = ids[(Math.max(0, ids.indexOf(foe() ? T.foeId : null)) + dir + ids.length) % ids.length]; }
    return [];
  }
  function start() {
    const why = refusal();
    if (why) { X.flash(why, true); return []; }
    const f = foe();
    return [X.eff('test-start', { teamId: team().id, foeId: f ? f.id : null, format: format(), cpu: T.cpu })];
  }
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return X.back();
    if (r.kind === 'change') return change(r.row, r.dir);
    if (r.kind !== 'choose') return [];
    return r.row.id === 'start' ? start() : X.back();
  }
  function helpOf(row) {
    const f = foe();
    switch (row && row.id) {
      case 'format': return ['6v6: every Pok{E}mon of both teams.', '3v3: each side picks three.'];
      case 'cpu': return ['How well the computer plays.', ''];
      case 'foe': return f ? ['Against "' + f.name + '",', 'played by the computer.'] : ['Against a random team,', 'a new one every time.'];
      case 'start': return refusal() || ['Opens the battle page with this', 'team. Your edits are saved first.'];
      default: return ['Back to the team.', ''];
    }
  }
  return {
    enter() { list.seek(rows(), (r) => r.id === 'start'); },
    press: (action, info) => act(list.press(action, rows(), info)),
    pointer: (ev) => act(list.pointer(ev, rows())),
    hit: (x, y) => list.hit(x, y, rows()),
    rects: () => list.rects(rows()),
    state: () => ({ ...list.state(), format: T.format, cpu: T.cpu, foeId: T.foeId }),
    view() {
      const t = team(), c = check(), rs = rows(), lv = list.view(rs), row = rs[list.cursor(rs.length)];
      return {
        kind: 'test', title: 'TEST: ' + t.name, list: lv, pagesFirst: false,
        menu: { rows: lv.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ...(r.value === undefined ? {} : { value: r.value }) })), cursor: lv.cursor },
        help: helpOf(row), say: 'Test battle with ' + t.name + ', ' + X.statusWords(c) + '. ' + (row ? row.label + (row.value !== undefined ? ' ' + row.value : '') + '.' : ''),
      };
    },
  };
}

const openCode = (X, t) => { X.screen('builder-code').begin(t ? { teamId: t.id } : null); return X.go('builder-code'); };

export const FAMILY = Object.freeze({
  id: 'io',
  screens: Object.freeze({
    'builder-code': Object.freeze({ parent: 'builder-teams', title: 'Team Builder: Team Code', need: 'profile', create: codeScreen }),
    'builder-test': Object.freeze({ parent: 'builder-team', title: 'Team Builder: Test Battle', need: 'team', create: testScreen }),
  }),
  ext: Object.freeze({
    'team.chips': [
      Object.freeze({ id: 'code', label: 'CODE', help: ['The team as a code: copy it to share', 'it, or paste one to add a team.'], run: (X, t) => openCode(X, t) }),
      Object.freeze({ id: 'test', label: 'TEST', help: ['A test battle against the', 'computer with this team.'], run: (X) => X.go('builder-test') }),
    ],
    'teams.rows': [Object.freeze({ id: 'code', label: 'IMPORT A CODE', help: ['Add a team from a team code', '(ARENA1...): paste it here.'], run: (X) => openCode(X, null) })],
  }),
});
