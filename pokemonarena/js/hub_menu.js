// pokemonarena/js/hub_menu.js -- a MENU for a hub app: a cursor over a list of rows, driven by the twelve actions and by pointer events, drawn by hub_screen.js's drawMenu (h.drawMenu).
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness, no imports. It is the main menu's own behaviour (hub_model.js) as a helper, so an app's lists move, wrap,
// hit-test and take taps exactly as the hub's do, without the app re-writing any of it. Optional: an app may draw and drive its screens any other way.
//
//   const menu = createMenu();                       // or createMenu({ x, y, w }): the window's interior left / top / width in logical pixels (default: the hub's menu window)
//   const rows = () => [{ id: 'go', kind: 'item', label: 'GO' }, { id: 'fmt', kind: 'choice', label: 'FORMAT', value: '3v3' }, { id: 'back', kind: 'button', label: 'BACK' }];
//   press(path, a) { const r = menu.press(a, rows()); ... }          // r: what the press MEANT (below); the app decides what it does
//   view(path, base) { return { ...base, menu: menu.view(rows()), ... }; }       // h.drawMenu(f, view.menu) draws it
//
// A ROW      { id, kind: 'item' | 'button' | 'choice', label, value? (a choice's current value), disabled? }   (the shape hub_screen.js drawMenu draws; any other key rides along)
// A RESULT   press() and pointer() return null (nothing happened) or one of
//            { kind: 'move', index }                 the cursor moved (a d-pad step, a hover, the wheel)
//            { kind: 'choose', row, index }          A, or a click, on an item / button row
//            { kind: 'change', row, index, dir }     left / right on a choice row (dir -1 / +1); A or a click on it is +1; a click on its left half is -1
//            { kind: 'refused', row, index }         A or a click on a disabled row
//            { kind: 'back' }                        B
// The row spacing follows the row count (menuPitchFor: the hub's rule), so a list of up to eight rows fits above the message box.

/** The hub's menu window (hub_model.js GEOM.menu): the interior's left, top and width. */
export const MENU = Object.freeze({ x: 12, y: 10, w: 124 });
/** Row spacing of a menu of n rows: hub_model.js menuPitch's rule (a test pins that they agree). */
export const menuPitchFor = (n) => (n > 7 ? 12 : n > 6 ? 14 : 16);

export function createMenu(geom = MENU) {
  const g = { x: geom.x, y: geom.y, w: geom.w };
  let cursor = 0;
  const clampTo = (n) => { cursor = n > 0 ? Math.max(0, Math.min(n - 1, cursor)) : 0; return cursor; };

  function rects(rows) { const p = menuPitchFor(rows.length); return rows.map((_, i) => ({ x: g.x - 4, y: g.y + i * p, w: g.w + 8, h: p })); }
  /** Which row is under the logical point? { kind: 'row', index, zone } | null. zone 'prev' = the left half of a choice row (its left arrow). */
  function hit(x, y, rows) {
    const n = rows.length, p = menuPitchFor(n);
    if (!n || x < g.x - 6 || x >= g.x + g.w + 6 || y < g.y || y >= g.y + n * p) return null;
    const index = Math.floor((y - g.y) / p), row = rows[index];
    return { kind: 'row', index, zone: row && row.kind === 'choice' && x < g.x + g.w * 0.45 + 6 && x > g.x + 38 ? 'prev' : 'main' };
  }
  function activate(rows, dir) {
    const row = rows[clampTo(rows.length)];
    if (!row) return null;
    if (row.disabled) return { kind: 'refused', row, index: cursor };
    return row.kind === 'choice' ? { kind: 'change', row, index: cursor, dir } : { kind: 'choose', row, index: cursor };
  }
  function press(action, rows) {
    const n = rows.length; clampTo(n);
    switch (action) {
      case 'up': if (!n) return null; cursor = (cursor + n - 1) % n; return { kind: 'move', index: cursor };
      case 'down': if (!n) return null; cursor = (cursor + 1) % n; return { kind: 'move', index: cursor };
      case 'left': case 'right': { const row = rows[cursor]; return row && row.kind === 'choice' && !row.disabled ? { kind: 'change', row, index: cursor, dir: action === 'left' ? -1 : 1 } : null; }
      case 'a': return activate(rows, 1);
      case 'b': return { kind: 'back' };
      default: return null;
    }
  }
  function pointer(ev, rows) {
    if (!ev) return null;
    if (ev.kind === 'wheel') { const k = Math.abs(ev.steps || 0); let r = null; for (let i = 0; i < k; i++) r = press((ev.steps || 0) > 0 ? 'down' : 'up', rows); return r; }
    const h = ev.x === undefined || ev.x === null ? null : hit(ev.x, ev.y, rows);
    if (!h) return null;
    cursor = h.index;
    if (ev.kind !== 'click') return { kind: 'move', index: cursor };
    return activate(rows, h.zone === 'prev' ? -1 : 1);
  }

  return {
    press, pointer, hit, rects,
    /** The cursor's row (clamped to `n` rows when given). */
    cursor: (n) => (n === undefined ? cursor : clampTo(n)),
    setCursor(i) { cursor = Math.max(0, i | 0); },
    /** Put the cursor on the row with this id (when there is one). -> whether it was found. */
    select(id, rows) { const i = rows.findIndex((r) => r.id === id); if (i < 0) return false; cursor = i; return true; },
    /** What h.drawMenu draws: { rows, cursor, x, y, w }. */
    view(rows) { return { rows: rows.map((r) => ({ ...r })), cursor: clampTo(rows.length), x: g.x, y: g.y, w: g.w }; },
  };
}
