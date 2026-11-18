// pokemonarena/js/builder_undo.js -- THE TEAM BUILDER, UNDO and REDO: where they stand in the picture on every editing screen.
//
// The reducer keeps the stack (editor_state.js: twenty steps; edits that carry the same `coalesce` key are ONE step; a new edit clears what could be redone). This module only asks it:
// X.dispatch({ type: 'undo' }) / ({ type: 'redo' }), and the reducer's own words ("Undid: change move.") go to the message box. On a keyboard Ctrl+Z / Ctrl+Y do the same from any builder
// screen (builder_ctl.js hears them and calls the model's undo() / redo()); the hub's touch pad has no such key, so EVERY EDITING SCREEN HAS THE TWO AS ROWS:
//
//   the trainer list   the ACTIVE trainer's menu (a rename, a portrait)
//   the teams list     two rows under NEW TEAM
//   the team           its MENU
//   RULES, CHECK       two rows above BACK
//   the Pokemon        the last two rows of every tab (BUILD, MOVES, STATS)
//
// They are always there, grey while there is nothing to undo or to redo (A then says so). An undo can take away the very thing a screen shows (the team just made, the Pokemon just added):
// the screen is then left for the nearest one that can be shown (X.settle()).
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness.

import { sentence } from './builder_parts.js';

export const UNDO_IDS = Object.freeze(['undo', 'redo']);
const LABEL = Object.freeze({ undo: 'UNDO', redo: 'REDO' });
const NOTHING = Object.freeze({ undo: 'Nothing to undo.', redo: 'Nothing to redo.' });
const stackOf = (X, id) => { const ed = X.ed(); return ed && !ed.readOnly ? (id === 'undo' ? ed.undo : ed.redo) : []; };

/** Whether there is a step to undo ('undo') or to redo ('redo'). */
export const canUndo = (X, id) => stackOf(X, id).length > 0;
export const isUndoRow = (id) => UNDO_IDS.includes(id);
/** What the row would do: "Undo: change move." (the reducer's label of the step), or that there is nothing. */
export function undoHelp(X, id) {
  const st = stackOf(X, id);
  return st.length ? [sentence(LABEL[id].charAt(0) + LABEL[id].slice(1).toLowerCase() + ': ' + st[st.length - 1].label), st.length > 1 ? (st.length - 1) + ' more before it.' : ''] : [NOTHING[id], ''];
}
/** Undo or redo one step through the reducer (its words go to the message box). -> effects: the move to another screen when the open one lost what it shows. */
export function undoAct(X, id) {
  if (!isUndoRow(id)) return [];
  X.dispatch({ type: id });
  return X.settle();
}
/** The two rows for a LIST screen (grey while there is nothing to do; A on a grey one says so in the reducer's words). */
export const undoRows = (X) => UNDO_IDS.map((id) => ({ id, kind: 'button', label: LABEL[id], ...(canUndo(X, id) ? {} : { disabled: true }) }));

// the two as entries of a registration point (a list's rows, a menu's rows): builder_parts.js extRows / extHelp / extRun show, word and run them
const entry = (id, more) => ({ id, label: LABEL[id], stay: true, help: (X) => undoHelp(X, id), off: (X) => (canUndo(X, id) ? null : NOTHING[id]), run: (X) => undoAct(X, id), ...(more || {}) });
const onActive = { when: (X, t) => !!t && t.id === X.activeId() };

export const FAMILY = Object.freeze({
  id: 'undo',
  screens: Object.freeze({}),
  ext: Object.freeze({
    'trainers.menu': [entry('undo', onActive), entry('redo', onActive)],
    'teams.rows': [entry('undo'), entry('redo')],
    'team.menu': [entry('undo'), entry('redo')],
  }),
});
