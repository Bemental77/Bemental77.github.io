// pokemonarena/js/uinav.js -- DOM spatial navigation: lets a controller or a keyboard drive an ordinary DOM page (the hub, the editor, the
// Controls panel) with the input layer's actions. Mouse and touch keep their native behaviour completely untouched.
//
//   const nav = enableDomNav(document.body, { input, onBack, scope, onMenu, onAction, onEdge });
//
// What the actions do
//   up/down/left/right  move focus to the nearest focusable in that direction BY GEOMETRY (see chooseNext); when nothing lies that way, fall back
//                       to DOM order (next for down/right, previous for up/left). NO WRAP: at the first/last control focus stays and onEdge(dir) fires.
//   a                   activate: click buttons / links / checkboxes / radios / summaries; selects try showPicker() and otherwise enter CYCLE mode;
//                       range and number inputs enter EDIT mode; text fields enter TYPING mode
//   b                   leave edit mode, else leave typing mode, else close the topmost [role=dialog], else onBack()
//   l / r               previous / next [role=tab] (or [data-tab]) in the current tablist, wrapping; stepped from the FOCUSED tab when focus is on one, else from the selected tab
//   start / x / y / select   the optional onMenu(ev) / onAction(ev) hooks
// Edit mode (range, number, select): left/right (and their repeats) change the value by one step, up/down by a bigger step (a tenth of a bounded
// range, else ten steps); A or B leaves. Outside edit mode the same directions navigate.
// Keyboard: arrows are NOT taken from text fields, selects, ranges or radio groups (the input layer's guard), so there the browser keeps them; Escape
// leaves such a field (focus is released, the position is remembered, the next arrow continues from it). Tab / Shift+Tab are never touched, except to
// keep focus inside an open modal dialog.
//
// The focus ring is data-driven: this module keeps <html data-input-source="keyboard|gamepad|mouse|touch|none"> current and input.css draws a
// high-contrast ring only for keyboard and gamepad. Honoured: [data-nav-skip], [inert], [hidden], disabled, aria-hidden and zero-size elements.

import { isTextTarget } from './input.js';

export const NAV_SELECTOR = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable=""], [contenteditable="true"], [tabindex]';
const COMPOSITE_ROLES = new Set(['option', 'radio', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'gridcell', 'switch', 'checkbox']);
const DIR = new Set(['up', 'down', 'left', 'right']);

/* ---------------------------------------------------------------------------------------------- pure geometry */

const ALIGN_TOL = 1;     // px of overlap tolerated before a neighbour stops counting as "strictly ahead"

// Project a rect onto the travel direction: `along` runs forward in the direction of travel, `orth` is the cross axis.
function project(r, dir) {
  const v = dir === 'up' || dir === 'down';
  const s = v ? [r.top, r.bottom] : [r.left, r.right];
  const along = dir === 'down' || dir === 'right' ? s : [-s[1], -s[0]];
  const orth = v ? [r.left, r.right] : [r.top, r.bottom];
  return { as: along[0], ae: along[1], ac: (along[0] + along[1]) / 2, os: orth[0], oe: orth[1], oc: (orth[0] + orth[1]) / 2 };
}
// Standard spatial-navigation choice. `cands` = [{ rect:{left,top,right,bottom}, ... }] in DOM order (the current element is NOT among them).
//   strictly ahead (no overlap along the travel axis):  score = gap + 2 * (cross-axis gap) + 0.5 * (how far the candidate's CENTRE lies outside
//                                                       the current element's cross-axis span, 0 when it lies inside) + 0.05 * (centre offset)
//   merely further along (overlapping, centre beyond):  same terms, plus 1000 so any strictly-ahead candidate always wins
// The centre term is deliberately NOT a plain centre-to-centre distance: that made a narrow control directly beneath a wide one (a checkbox under a
// full-width number field, 23 px away) lose to a full-width button two rows down, because its centre is far from the wide field's centre. Measured on
// dev/input_lab.html: Down from #num skipped #chk (old score 129 vs 68). Now anything under the current element counts as aligned and the small
// 0.05 term only breaks ties between aligned candidates in favour of the better-centred one.
// Lowest score wins; a tie goes to the earlier candidate in DOM order. Returns { cand, via:'strict'|'loose' } or null.
export function chooseNext(cur, cands, dir) {
  const a = project(cur, dir);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < cands.length; i++) {
    const b = project(cands[i].rect, dir);
    const gap = b.as - a.ae;
    const ogap = Math.max(0, Math.max(a.os, b.os) - Math.min(a.oe, b.oe));
    const oc = Math.abs(b.oc - a.oc);
    // W1 fix A9: a candidate whose cross-axis span covers at least half of the narrower of the two sits DIRECTLY ahead whatever its centre says (a full-width button right under a
    // narrow one used to lose to a narrow control two rows further down, because the wide one's centre lay far outside the narrow one's span)
    const ow = Math.min(a.oe, b.oe) - Math.max(a.os, b.os);
    const aligned = ow > 0 && ow >= 0.5 * Math.min(a.oe - a.os, b.oe - b.os);
    const ocOut = aligned ? 0 : Math.max(0, a.os - b.oc, b.oc - a.oe);
    let score, via;
    if (gap >= -ALIGN_TOL) { score = Math.max(0, gap) + 2 * ogap + 0.5 * ocOut + 0.05 * oc; via = 'strict'; }
    else if (b.ac > a.ac + ALIGN_TOL) { score = 1000 + (b.ac - a.ac) + 2 * ogap + 0.5 * ocOut + 0.05 * oc; via = 'loose'; }
    else continue;
    if (score < bestScore) { bestScore = score; best = { cand: cands[i], via }; }
  }
  return best;
}

const decimals = (n) => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
// One step of a numeric control. o = { min, max, step, dir: +1 | -1, big: bool }.
export function stepNumber(cur, o) {
  const step = o.step > 0 ? o.step : 1;
  const bounded = Number.isFinite(o.min) && Number.isFinite(o.max);
  const base = Number.isFinite(o.min) ? o.min : 0;
  const bigStep = bounded ? Math.max(step, Math.round((o.max - o.min) / 10 / step) * step) : step * 10;
  const delta = (o.big ? bigStep : step) * o.dir;
  let v = (Number.isFinite(cur) ? cur : base) + delta;
  v = base + Math.round((v - base) / step) * step;
  if (Number.isFinite(o.min)) v = Math.max(o.min, v);
  if (Number.isFinite(o.max)) v = Math.min(o.max, v);
  return Number(v.toFixed(Math.min(10, Math.max(decimals(step), decimals(base)))));
}

export function classify(el) {
  if (!el) return 'none';
  if (el.isContentEditable === true) return 'text';
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return 'text';
  if (tag === 'SELECT') return 'select';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A' || tag === 'AREA') return 'link';
  if (tag === 'SUMMARY') return 'summary';
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    if (type === 'range') return 'range';
    if (type === 'number') return 'number';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
    if (type === 'file' || type === 'color') return 'button';
    if (/^(date|time|datetime-local|month|week)$/.test(type)) return 'date';
    return 'text';
  }
  return 'other';
}

/* ============================================================================================ enableDomNav */

export function enableDomNav(root, opts = {}) {
  const input = opts.input;
  if (!input || typeof input.on !== 'function') throw new Error('enableDomNav(root, { input }) needs an input layer');
  const doc = root && root.nodeType === 9 ? root : (root && root.ownerDocument) || document;
  const view = doc.defaultView || window;
  const rootEl = root && root.nodeType === 9 ? doc.body : root;
  const state = { editing: null, editKind: '', typing: false, typingEl: null, last: null, activated: null };
  let live = null, disabled = false;
  const offs = [];
  const docListeners = [];
  const addDoc = (type, fn, o) => { doc.addEventListener(type, fn, o); docListeners.push([type, fn, o]); };

  /* ---- announcements (polite live region, visually hidden) ---- */
  function announce(msg) {
    try {
      if (!live) {
        live = doc.createElement('div');
        live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('data-nav-skip', '');
        live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
        (doc.body || doc.documentElement).appendChild(live);
      }
      live.textContent = '';
      live.textContent = msg;
    } catch (_e) { /* a hint is never worth breaking the page */ }
  }

  /* ---- candidates ---- */
  function usable(el) {
    if (el.disabled) return false;
    if (el.closest('[data-nav-skip], [inert], [hidden], fieldset[disabled], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = view.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function isCandidate(el) {
    if (!el.matches(NAV_SELECTOR)) return false;
    if (el.tabIndex >= 0 || el.hasAttribute('data-nav')) return true;
    return el.hasAttribute('tabindex') && COMPOSITE_ROLES.has(String(el.getAttribute('role') || '').toLowerCase());
  }
  function collect(scope) {
    const out = [];
    for (const el of scope.querySelectorAll(NAV_SELECTOR)) if (isCandidate(el) && usable(el)) out.push(el);
    return out;
  }
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[hidden], [inert], [data-nav-skip]') && view.getComputedStyle(el).visibility !== 'hidden'; };

  /* ---- dialogs ---- */
  function dialogs() { return Array.from(doc.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')).filter(visible); }
  function topDialog() { const d = dialogs(); return d.length ? d[d.length - 1] : null; }
  function modalDialog() {
    const d = dialogs().filter((x) => x.getAttribute('aria-modal') === 'true' || x.hasAttribute('data-nav-modal') || (x.tagName === 'DIALOG' && x.matches(':modal')));
    return d.length ? d[d.length - 1] : null;
  }
  function closeDialog(d) {
    const explicit = d.querySelector('[data-nav-close]');
    if (explicit) { explicit.click(); return true; }
    if (d.tagName === 'DIALOG' && typeof d.close === 'function') {
      const ev = new Event('cancel', { cancelable: true });
      d.dispatchEvent(ev);
      if (!ev.defaultPrevented) { d.close(); }
      return true;
    }
    for (const b of d.querySelectorAll('button, [role="button"]')) {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (/^(close|cancel|dismiss|back|x)\b/i.test(label) && usable(b)) { b.click(); return true; }
    }
    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    (doc.activeElement && d.contains(doc.activeElement) ? doc.activeElement : d).dispatchEvent(esc);
    return esc.defaultPrevented;
  }

  /* ---- scope + current element ---- */
  function scopeEl() {
    const m = modalDialog();
    if (m) return m;
    const s = opts.scope;
    let el = typeof s === 'function' ? s() : typeof s === 'string' ? doc.querySelector(s) : s;
    if (!el || !el.isConnected) el = rootEl;
    return el || doc.body;
  }
  function currentEl(scope) {
    const a = doc.activeElement;
    if (a && a !== doc.body && a !== doc.documentElement && scope.contains(a)) return a;
    if (state.last && state.last.isConnected && scope.contains(state.last) && usable(state.last)) return state.last;
    return null;
  }
  function focusEl(el) {
    if (!el) return false;
    exitEdit(true);
    try { el.focus({ preventScroll: true }); } catch (_e) { return false; }
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_e) { /* old engines */ }
    state.last = el; state.typing = false; state.typingEl = null;
    return true;
  }
  function pickDefault(cands) {
    return cands.find((c) => c.hasAttribute('data-nav-default') || c.hasAttribute('autofocus')) || cands[0];
  }

  /* ---- moving ---- */
  function move(dir, ev) {
    const scope = scopeEl();
    const cands = collect(scope);
    if (!cands.length) return false;
    const cur = currentEl(scope);
    if (!cur) return focusEl(pickDefault(cands));
    const others = cands.filter((c) => c !== cur && !cur.contains(c) && !c.contains(cur));
    const curRect = cur.getBoundingClientRect();
    const hit = chooseNext(curRect, others.map((el) => ({ el, rect: el.getBoundingClientRect() })), dir);
    let target = hit ? hit.cand.el : null;
    if (!target) {                                              // nothing lies that way: DOM order, no wrap
      const fwd = dir === 'down' || dir === 'right';
      if (fwd) target = others.find((c) => cur.compareDocumentPosition(c) & 4) || null;
      else for (let i = others.length - 1; i >= 0; i--) if (cur.compareDocumentPosition(others[i]) & 2) { target = others[i]; break; }
    }
    if (!target) { if (typeof opts.onEdge === 'function') opts.onEdge(dir, cur, ev); return false; }
    return focusEl(target);
  }

  /* ---- edit / typing modes ---- */
  function exitEdit(silent) {
    if (state.editing) { state.editing.removeAttribute('data-nav-editing'); if (!silent) announce('Done editing'); }
    state.editing = null; state.editKind = '';
  }
  function enterEdit(el, kind) {
    state.editing = el; state.editKind = kind; el.setAttribute('data-nav-editing', '1');
    const name = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].textContent) || '').trim();
    announce('Editing ' + name + '. Left and right change the value, up and down change it faster, B finishes.');
  }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
  function selectStep(el, dirSign) {
    let i = el.selectedIndex + dirSign;
    while (i >= 0 && i < el.options.length && el.options[i].disabled) i += dirSign;
    if (i < 0 || i >= el.options.length) return false;
    el.selectedIndex = i; fire(el, 'input'); fire(el, 'change');
    return true;
  }
  function numberStep(el, dirSign, big) {
    const isRange = classify(el) === 'range';
    const min = el.min !== '' && Number.isFinite(parseFloat(el.min)) ? parseFloat(el.min) : isRange ? 0 : -Infinity;
    const max = el.max !== '' && Number.isFinite(parseFloat(el.max)) ? parseFloat(el.max) : isRange ? 100 : Infinity;
    const sattr = parseFloat(el.step);
    const step = Number.isFinite(sattr) && sattr > 0 ? sattr : 1;
    const cur = parseFloat(el.value);
    const next = stepNumber(cur, { min, max, step, dir: dirSign, big });
    if (String(next) === String(cur)) return false;
    el.value = String(next); fire(el, 'input'); fire(el, 'change');
    return true;
  }
  function editStep(dir, repeat) {
    const el = state.editing;
    if (!el || !el.isConnected) { exitEdit(true); return false; }
    if (state.editKind === 'select') return selectStep(el, dir === 'right' || dir === 'down' ? 1 : -1);
    const big = dir === 'up' || dir === 'down';
    return numberStep(el, dir === 'right' || dir === 'up' ? 1 : -1, big);
  }

  /* ---- actions ---- */
  function activate(ev) {
    const scope = scopeEl();
    let el = currentEl(scope);
    if (!el) { const c = collect(scope); if (c.length) focusEl(pickDefault(c)); return; }
    if (doc.activeElement !== el) focusEl(el);
    if (state.editing === el) { exitEdit(); return; }
    const kind = classify(el);
    state.activated = el;
    if (kind === 'select') {
      if (opts.selectPicker !== false && typeof el.showPicker === 'function') {
        try { el.showPicker(); return; } catch (_e) { /* needs a user gesture a gamepad press does not give: cycle instead */ }
      }
      enterEdit(el, 'select'); return;
    }
    if (kind === 'range' || kind === 'number') { enterEdit(el, 'number'); return; }
    if (kind === 'text') { state.typing = true; state.typingEl = el; try { el.focus({ preventScroll: true }); if (typeof el.select === 'function' && el.value) el.select(); } catch (_e) { /* ignore */ } announce('Typing. B finishes.'); return; }
    el.click();
  }
  function back(ev) {
    if (state.editing) { exitEdit(); return; }
    const a = doc.activeElement;
    if (state.typing) { state.typing = false; announce('Done typing'); return; }
    // keyboard B on a control that keeps the arrow keys (range): release it first so the arrows navigate again
    if (ev && ev.source === 'keyboard' && a && a !== doc.body && ['range', 'number', 'select', 'text'].includes(classify(a)) && true) { leaveField(a); return; }
    const d = topDialog();
    if (d) {
      const opener = state.activated;
      if (closeDialog(d)) {
        setTimeout(() => { const act = doc.activeElement; if ((!act || act === doc.body) && opener && opener.isConnected) { try { opener.focus({ preventScroll: true }); state.last = opener; } catch (_e) { /* ignore */ } } }, 0);
      }
      return;
    }
    if (typeof opts.onBack === 'function') opts.onBack(ev);
  }
  function leaveField(el) { state.last = el; state.typing = false; state.typingEl = null; exitEdit(true); try { el.blur(); } catch (_e) { /* ignore */ } }
  function cycleTabs(delta) {
    const scope = scopeEl();
    const cur = currentEl(scope);
    let list = cur && cur.closest('[role="tablist"], [data-tabs]');
    if (!list || !scope.contains(list)) list = Array.from(scope.querySelectorAll('[role="tablist"], [data-tabs]')).find(visible) || null;
    if (!list) return false;
    const tabs = Array.from(list.querySelectorAll('[role="tab"], [data-tab]')).filter((t) => visible(t) && !t.disabled && t.getAttribute('aria-disabled') !== 'true');
    if (tabs.length < 2) return false;
    // Step from where the player IS: the focused tab when focus sits on one (the ring is what they are looking at; arrowing onto a tab moves
    // focus without selecting it, and stepping from the SELECTED tab then looked like the press did nothing), else from the selected tab.
    let idx = cur && list.contains(cur) ? tabs.indexOf(cur) : -1;
    if (idx < 0) idx = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true' || (t.getAttribute('aria-current') && t.getAttribute('aria-current') !== 'false'));
    if (idx < 0) idx = delta > 0 ? -1 : 0;                    // nothing selected, focus elsewhere: next -> first tab, previous -> last
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    const focusWasThere = !cur || list.contains(cur) || doc.activeElement === doc.body;
    next.click();
    if (focusWasThere && next.isConnected) focusEl(next);
    return true;
  }

  function onAction(ev) {
    if (disabled || !ev.pressed) return;
    const act = ev.action;
    if (DIR.has(act)) {
      if (state.editing) { editStep(act, ev.repeat); return; }
      const a = doc.activeElement;
      if (state.typing && a && a === state.typingEl) { const v = a.value !== undefined ? a.value : a.textContent; if (v === '') state.typing = false; else return; }
      move(act, ev);
      return;
    }
    if (act === 'a') { if (ev.native) return; activate(ev); return; }
    if (act === 'b') { back(ev); return; }
    if (act === 'l') { cycleTabs(-1); return; }
    if (act === 'r') { cycleTabs(1); return; }
    if (act === 'start') { if (typeof opts.onMenu === 'function') opts.onMenu(ev); return; }
    if (typeof opts.onAction === 'function') opts.onAction(ev);
  }
  // the right stick scrolls the nearest scrollable ancestor of the focused element (or the page)
  function onPointer(ev) {
    if (disabled || ev.kind !== 'wheel' || ev.x !== null) return;
    let el = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    while (el && el !== doc.documentElement) {
      const cs = view.getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) { el.scrollBy({ top: ev.steps * 64 }); return; }
      el = el.parentElement;
    }
    view.scrollBy({ top: ev.steps * 64 });
  }
  function onSource(ev) { doc.documentElement.setAttribute('data-input-source', ev.source); }

  /* ---- document-level listeners (the few things that are not actions) ---- */
  const evTarget = (e) => { try { const p = typeof e.composedPath === 'function' ? e.composedPath() : null; if (p && p.length) return p[0]; } catch (_e) { /* ignore */ } return e.target; };
  function onKeyDown(e) {
    if (disabled || e.defaultPrevented) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = evTarget(e);
      if (t && t !== doc.body && isTextTarget(t)) { leaveField(t); return; }      // the input layer never sees Escape in a field: leave it here
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {                  // a modal keeps focus inside itself
      const m = modalDialog();
      if (!m) return;
      const tabbable = collect(m).filter((c) => c.tabIndex >= 0);
      if (!tabbable.length) return;
      const a = doc.activeElement, first = tabbable[0], last = tabbable[tabbable.length - 1];
      if (e.shiftKey && (a === first || !m.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !m.contains(a))) { e.preventDefault(); first.focus(); }
    }
  }
  function onFocusOut(e) {
    if (state.editing && e.target === state.editing) exitEdit(true);
    if (e.target === state.typingEl) { state.typing = false; state.typingEl = null; }
  }
  function onInput(e) { const t = e.target; if (t && classify(t) === 'text') { state.typing = true; state.typingEl = t; } }

  offs.push(input.on('action', onAction), input.on('pointer', onPointer), input.on('source', onSource));
  addDoc('keydown', onKeyDown);
  addDoc('focusout', onFocusOut);
  addDoc('input', onInput);
  doc.documentElement.setAttribute('data-input-source', input.sourceKnown ? input.lastSource : 'none');

  return {
    candidates: () => collect(scopeEl()),
    current: () => currentEl(scopeEl()),
    focusFirst: () => { const c = collect(scopeEl()); return c.length ? focusEl(pickDefault(c)) : false; },
    move: (dir) => move(dir),
    editing: () => state.editing,
    typing: () => state.typing,
    refresh() { return collect(scopeEl()).length; },
    disable() {
      if (disabled) return;
      disabled = true;
      exitEdit(true);
      for (const o of offs.splice(0)) o();
      for (const [type, fn, o] of docListeners.splice(0)) doc.removeEventListener(type, fn, o);
      if (live && live.parentNode) live.parentNode.removeChild(live);
      live = null;
    },
  };
}
