// pokemonarena/js/osk.js -- an ON-SCREEN KEYBOARD for the controller, so a player with only a gamepad can fill in every text field of the game
// (a team name, a nickname, a search box, a pasted code). Without it uinav.js can only put a text field into TYPING mode, which needs a physical
// keyboard (see INPUT.md "Controller and text fields").
//
//   const osk = enableOnScreenKeyboard({ input });      // input from input.js; call osk.disable() to remove it
//   osk.open(field)  osk.close()  osk.isOpen()          // open() is for tests; the layer opens it by itself
//
// WHEN IT OPENS: only when the action 'a' arrives from a CONTROLLER (event.source === 'gamepad') while a text field (an <input> of a text kind or a
// <textarea>, not read-only, not disabled) has focus. A keyboard or a finger never sees it: they type natively. A MOUSE-only visitor (no keyboard to type with) gets a small
// "Keyboard" button beside the focused field that opens it (W1 fix A8; it goes away when a key is pressed or the screen is touched). It is a plain modal dialog
// ([role=dialog][aria-modal]) of plain buttons, so uinav.js drives it (d-pad moves, A presses a key, B cancels) and a mouse or finger can use it too.
//
// KEYS: letters, digits and the punctuation the game's text fields accept, Shift (one-shot capital; a field that is empty starts capital, like
// the game's own name entry), SPACE, DEL, CLEAR, CANCEL, OK. Shortcuts while it is open: X = DEL, Y = SPACE, START = OK, B = CANCEL.
// OK writes the text into the field and fires `input` and `change` on it exactly like typing would (the page's own handlers see no difference),
// then lets go of the field so the d-pad navigates again. CANCEL leaves the field as it was. The field's maxlength is honoured.

const STYLE_ID = 'arena-osk-style';
const CSS = `
.arena-osk-scrim { position: fixed; inset: 0; z-index: 3000; background: rgba(0, 0, 0, .78); display: flex; align-items: flex-end; justify-content: center; padding: 8px var(--gutter, 16px) max(8px, env(safe-area-inset-bottom)); overflow-y: auto; }
.arena-osk { width: min(100%, 560px); background: var(--panel, #1a1a1f); color: var(--fg, #ddd); border: 1px solid var(--line, #3a3a44); border-radius: 10px; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.arena-osk h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.arena-osk .osk-text { min-height: 44px; display: flex; align-items: center; padding: 6px 10px; margin-bottom: 8px; background: #000; border: 1px solid var(--line, #3a3a44); border-radius: 6px; font-size: 18px; overflow-wrap: anywhere; white-space: pre-wrap; }
.arena-osk .osk-text .caret { display: inline-block; width: 2px; height: 1.1em; margin-left: 1px; background: var(--accent, #6af); }
.arena-osk .osk-count { margin: 0 0 6px; font-size: 12px; color: var(--dim, #8d8d99); }
.arena-osk .osk-keys { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 4px; }
.arena-osk .osk-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; margin-top: 6px; }
.arena-osk button { font: inherit; font-size: 16px; color: var(--fg, #ddd); background: var(--btn, #222); border: 1px solid var(--line, #3a3a44); border-radius: 6px; min-height: 44px; min-width: 0; padding: 0 2px; cursor: pointer; touch-action: manipulation; }
.arena-osk button:hover { background: var(--btn-hi, #333); }
.arena-osk button[aria-pressed="true"] { background: #27466f; border-color: var(--accent, #6af); }
.arena-osk button.osk-ok { background: #1f4d2e; border-color: #4a9; }
.arena-osk button[disabled] { opacity: .4; }
.arena-osk-open { position: fixed; z-index: 2900; width: 96px; height: 44px; margin: 0; padding: 0 4px; font: inherit; font-size: 14px; color: var(--fg, #ddd); background: var(--btn, #222); border: 1px solid var(--line, #3a3a44); border-radius: 6px; cursor: pointer; }
.arena-osk-open:hover { background: var(--btn-hi, #333); }
`;
const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', ',', '-'],
  ['#', '!', '?', ':', '/', '(', ')', '_', '&', '+'],
];
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', '']);

export function isTextField(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return TEXT_TYPES.has(String(el.getAttribute('type') || '').toLowerCase());
}

export function enableOnScreenKeyboard({ input, document: doc = document } = {}) {
  if (!input || typeof input.on !== 'function') throw new Error('enableOnScreenKeyboard({ input }) needs an input layer');
  let scrim = null, textEl = null, countEl = null, field = null, value = '', shift = false, restore = null, disabled = false;
  const offs = [];
  let keyBtns = [];

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    const st = doc.createElement('style'); st.id = STYLE_ID; st.textContent = CSS; (doc.head || doc.documentElement).appendChild(st);
  }
  const max = () => (field && Number.isInteger(field.maxLength) && field.maxLength > 0 ? field.maxLength : 1000);
  function paint() {
    if (!scrim) return;
    textEl.replaceChildren(doc.createTextNode(value), Object.assign(doc.createElement('span'), { className: 'caret' }));
    countEl.textContent = value.length + ' of ' + max() + ' characters' + (shift ? ' - next letter is a capital' : '');
    for (const b of keyBtns) {
      const k = b.dataset.key;
      if (k && k.length === 1) b.textContent = shift && /[a-z]/.test(k) ? k.toUpperCase() : k;
      if (b.dataset.role === 'shift') b.setAttribute('aria-pressed', String(shift));
    }
  }
  function type(ch) {
    if (value.length >= max()) return;
    value += shift && /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
    shift = false; paint();
  }
  const back = () => { value = value.slice(0, -1); paint(); };
  const space = () => type(' ');

  function commit() {
    if (!field) return close();
    const f = field;
    if (f.value !== value) {
      f.value = value;
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
    finish(true);
  }
  function finish(keepEdit) {
    const f = field, r = restore;
    if (scrim) scrim.remove();
    scrim = null; textEl = null; countEl = null; field = null; keyBtns = []; restore = null;
    delete doc.body.dataset.osk;
    if (f && f.isConnected) {
      try { f.focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
      // let go of the field: uinav.js treats a focused text field as "typing" and would swallow the d-pad; blurring it keeps its place (it is remembered)
      try { f.blur(); } catch (_e) { /* ignore */ }
    } else if (r && r.isConnected) { try { r.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    void keepEdit;
  }
  function close() { finish(false); }

  function open(el) {
    if (disabled || scrim || !isTextField(el)) return false;
    ensureStyle();
    field = el; restore = el; value = String(el.value || ''); shift = value === '';
    const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('placeholder') || 'Text').trim();
    const mk = (tag, props, ...kids) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(props || {})) { if (k === 'class') n.className = v; else if (k === 'dataset') Object.assign(n.dataset, v); else n.setAttribute(k, String(v)); } for (const c of kids) n.append(c); return n; };
    const key = (k) => { const b = mk('button', { type: 'button', 'aria-label': k === ' ' ? 'space' : k, dataset: { key: k } }, k); b.addEventListener('click', () => type(k)); return b; };
    const act = (text, role, fn, extra) => { const b = mk('button', { type: 'button', dataset: { role }, ...(extra || {}) }, text); b.addEventListener('click', fn); return b; };
    const keys = mk('div', { class: 'osk-keys', role: 'group', 'aria-label': 'Keys' });
    for (const row of ROWS) for (const k of row) keys.append(key(k));
    const shiftB = act('Shift', 'shift', () => { shift = !shift; paint(); }, { 'aria-pressed': 'false' });
    const spaceB = act('Space', 'space', space);
    const delB = act('Del', 'del', back, { 'aria-label': 'Delete the last character' });
    const clearB = act('Clear', 'clear', () => { value = ''; shift = true; paint(); }, { 'aria-label': 'Clear everything' });
    const cancelB = act('Cancel', 'cancel', close, { 'data-nav-close': '' });
    const okB = act('OK', 'ok', commit); okB.classList.add('osk-ok');
    const bar = mk('div', { class: 'osk-row', role: 'group', 'aria-label': 'Edit' }, shiftB, spaceB, delB, clearB, cancelB, okB);
    textEl = mk('div', { class: 'osk-text', role: 'status', 'aria-live': 'polite', 'aria-label': 'Text so far' });
    countEl = mk('p', { class: 'osk-count' });
    const dlg = mk('div', { class: 'arena-osk', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'arena-osk-title', dataset: { osk: '1' } },
      mk('h2', { id: 'arena-osk-title' }, 'Type: ' + label), textEl, countEl, keys, bar);
    scrim = mk('div', { class: 'arena-osk-scrim' }, dlg);
    keyBtns = [...keys.querySelectorAll('button'), shiftB];
    doc.body.appendChild(scrim);
    doc.body.dataset.osk = 'open';
    paint();
    // the first key in the middle of the letters; the d-pad takes it from there
    const first = keys.querySelector('[data-key="a"]') || keys.querySelector('button');
    setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }, 0);
    return true;
  }

  offs.push(input.on('action', (e) => {
    if (disabled || !e.pressed) return;
    if (scrim) {                                              // shortcuts while open
      if (e.repeat && e.action !== 'x') return;
      if (e.action === 'x') back();
      else if (e.action === 'y') space();
      else if (e.action === 'start') commit();
      return;
    }
    if (e.action !== 'a' || e.source !== 'gamepad' || e.native) return;
    const a = doc.activeElement;
    if (isTextField(a)) open(a);
  }));

  // W1 fix A8: a MOUSE-ONLY desktop has no keyboard to type with. While a text field has focus and the mouse is the device in use, a small "Keyboard" button beside the field opens this
  // same on-screen keyboard (a keyboard, a finger and a controller are left as they were: they type natively / A opens it). Pressing a key, or touching, makes the button go away.
  let kbBtn = null, kbField = null;
  const hideKb = () => { if (kbBtn) { kbBtn.remove(); kbBtn = null; } kbField = null; };
  function placeKb(f) {
    if (!kbBtn) {
      ensureStyle();
      kbBtn = doc.createElement('button'); kbBtn.type = 'button'; kbBtn.className = 'arena-osk-open'; kbBtn.textContent = 'Keyboard';
      kbBtn.setAttribute('aria-label', 'Open the on-screen keyboard'); kbBtn.dataset.oskOpen = '1';
      kbBtn.addEventListener('mousedown', (e) => e.preventDefault());           // the click must not take focus away from the field
      kbBtn.addEventListener('click', () => { const t = kbField; hideKb(); if (t && t.isConnected) open(t); });
      doc.body.appendChild(kbBtn);
    }
    kbField = f;
    const r = f.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight, w = 96, hh = 44;
    let left = r.right + 6, top = r.top + (r.height - hh) / 2;
    if (left + w > vw - 4) { left = Math.max(4, Math.min(vw - w - 4, r.right - w)); top = r.bottom + 4; if (top + hh > vh - 4) top = Math.max(4, r.top - hh - 4); }
    kbBtn.style.left = Math.round(left) + 'px'; kbBtn.style.top = Math.round(Math.max(4, top)) + 'px';
  }
  const onFocusIn = (e) => { if (disabled || scrim) return; const f = e.target; if (isTextField(f) && input.sourceKnown && input.lastSource === 'mouse') placeKb(f); else hideKb(); };
  const onFocusOut = (e) => { if (kbBtn && e.relatedTarget === kbBtn) return; setTimeout(() => { if (!isTextField(doc.activeElement)) hideKb(); }, 0); };
  doc.addEventListener('focusin', onFocusIn, true); doc.addEventListener('focusout', onFocusOut, true);
  offs.push(() => { doc.removeEventListener('focusin', onFocusIn, true); doc.removeEventListener('focusout', onFocusOut, true); hideKb(); });
  offs.push(input.on('source', (e) => { if (e.source !== 'mouse') hideKb(); }));

  return {
    open, close, isOpen: () => !!scrim,
    value: () => value,
    disable() { if (disabled) return; disabled = true; close(); for (const o of offs.splice(0)) o(); },
  };
}
