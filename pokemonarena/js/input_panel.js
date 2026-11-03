// pokemonarena/js/input_panel.js -- the Controls settings panel. Renders into a container:
//   * a live "last input" readout, the connected controllers, the Xbox / Nintendo layout switch
//   * a table of every action x (keyboard keys, controller buttons) with press-to-bind capture, conflict detection (swap / take / cancel)
//   * per-device Reset buttons that are ALWAYS the second thing in the panel (a pad-only player who bound themselves into a corner can get out)
// It is plain DOM, so uinav.js drives it with a keyboard or a controller and a mouse or finger just clicks it. Capture gives up after
// TIMING.captureTimeoutMs on its own and has a Cancel button, so nobody can be trapped waiting for a press that cannot come.
//
//   const panel = mountControlsPanel(container, { input });   // panel.refresh(), panel.destroy()

import { ACTIONS, ACTION_LABELS, TIMING } from './input.js';

const SOURCE_NAMES = { keyboard: 'Keyboard', mouse: 'Mouse', touch: 'Touch', gamepad: 'Controller' };
const MAX_CHIPS = 4;

export function mountControlsPanel(container, opts = {}) {
  const input = opts.input;
  if (!input || !input.bindings) throw new Error('mountControlsPanel(container, { input }) needs an input layer');
  const doc = opts.document || container.ownerDocument;
  let cap = null;                 // { device, action, slot }
  let conflict = null;            // { device, action, slot, value, label, others }
  let status = { text: '', tone: '' };
  let timer = null, left = 0, destroyed = false;
  const last = { source: null, raw: null, action: null };
  const offs = [];

  const h = (tag, attrs, ...kids) => {
    const el = doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') for (const d of Object.keys(v)) el.dataset[d] = v[d];
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(c.nodeType ? c : doc.createTextNode(String(c))); };
    kids.forEach(add);
    return el;
  };

  const familyName = (f) => ({ xbox: 'Xbox style', playstation: 'PlayStation style', nintendo: 'Nintendo style', generic: 'Generic' }[f] || f);
  const setStatus = (text, tone) => { status = { text, tone: tone || '' }; const el = container.querySelector('[data-ip="status"]'); if (el) { el.textContent = text; el.dataset.tone = status.tone; } };

  /* ---- capture ---- */
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function startCapture(device, action, slot) {
    conflict = null;
    cap = { device, action, slot };
    left = Math.round(TIMING.captureTimeoutMs / 1000);
    const what = device === 'keyboard' ? 'a key' : 'a controller button';
    status = { text: 'Press ' + what + ' for "' + ACTION_LABELS[action] + '" (' + left + 's). Esc or Cancel stops.', tone: 'warn' };
    input.beginCapture(device, (result) => onCaptured(result, device, action, slot));
    stopTimer();
    timer = setInterval(() => {
      left = Math.max(0, left - 1);
      if (cap) setStatus('Press ' + what + ' for "' + ACTION_LABELS[action] + '" (' + left + 's). Esc or Cancel stops.', 'warn');
    }, 1000);
    render();
  }
  function onCaptured(result, device, action, slot) {
    if (destroyed) return;
    stopTimer(); cap = null;
    if (!result.ok) { status = { text: result.reason === 'timeout' ? 'No press arrived, so nothing changed.' : 'Cancelled. Nothing changed.', tone: '' }; render(); return; }
    const r = input.bindings.rebind(device, action, slot, result.value);
    if (r.ok) status = { text: '"' + ACTION_LABELS[action] + '" is now ' + result.label + '.', tone: 'good' };
    else if (r.reason === 'conflict') {
      conflict = { device, action, slot, value: result.value, label: result.label, others: r.conflicts };
      status = { text: result.label + ' is taken. Choose what to do with it below.', tone: 'warn' };
    } else if (r.reason === 'full') status = { text: 'That action already has ' + MAX_CHIPS + ' bindings. Remove one first.', tone: 'bad' };
    else status = { text: 'That cannot be used as a control.', tone: 'bad' };
    render(conflict ? 'cf-swap' : null);
  }
  function resolve(mode) {
    const c = conflict; conflict = null;
    if (!c || mode === 'cancel') { status = { text: 'Cancelled. Nothing changed.', tone: '' }; render(); return; }
    const r = input.bindings.rebind(c.device, c.action, c.slot, c.value, { onConflict: mode });
    status = r.ok ? { text: (mode === 'swap' ? 'Swapped: ' : 'Moved: ') + '"' + ACTION_LABELS[c.action] + '" is now ' + c.label + '.', tone: 'good' }
      : r.reason === 'would-empty' ? { text: 'Nothing changed: "' + ACTION_LABELS[r.conflicts[0]] + '" would be left with no ' + (c.device === 'keyboard' ? 'key' : 'button') + ', and the screens could not be used without it. Choose "Swap them" instead.', tone: 'bad' }
      : { text: 'Could not apply that.', tone: 'bad' };
    render();
  }
  function doReset(device) {
    if (cap) input.cancelCapture();
    conflict = null;
    input.bindings.reset(device);
    status = { text: (device === 'keyboard' ? 'Keyboard' : device === 'gamepad' ? 'Controller' : 'Keyboard and controller') + ' controls are back to the defaults.', tone: 'good' };
    render('reset-' + (device === 'keyboard' ? 'kb' : device === 'gamepad' ? 'pad' : 'all'));
  }

  /* ---- rendering ---- */
  function padFamilyNow() { const p = input.pads[0]; return p ? p.family : 'xbox'; }
  function chipLabel(device, v) { return device === 'keyboard' ? input.keyLabel(v) : input.buttonLabel(v); }
  function cell(device, action) {
    const b = input.bindings.get();
    const list = device === 'keyboard' ? b.keyboard[action] : b.gamepad.buttons[action];
    const nm = ACTION_LABELS[action], dv = device === 'keyboard' ? 'keyboard key' : 'controller button';
    const chips = list.map((v, i) => {
      const capturing = cap && cap.device === device && cap.action === action && cap.slot === i;
      return h('span', { class: 'ip-pair' },
        h('button', { type: 'button', class: 'ip-chip', 'data-fk': (device === 'keyboard' ? 'kb-' : 'pad-') + action + '-' + i, dataset: { chip: device, action, slot: i, capturing: capturing ? '1' : '' },
          'aria-label': nm + ' ' + dv + ' ' + chipLabel(device, v) + '. Press to change it.', onClick: () => startCapture(device, action, i) }, capturing ? 'press...' : chipLabel(device, v)),
        list.length > 1 ? h('button', { type: 'button', class: 'ip-x', 'data-fk': (device === 'keyboard' ? 'kbx-' : 'padx-') + action + '-' + i, 'aria-label': 'Remove ' + dv + ' ' + chipLabel(device, v) + ' from ' + nm,
          onClick: () => { const r = input.bindings.remove(device, action, i); status = r.ok ? { text: 'Removed ' + chipLabel(device, v) + ' from "' + nm + '".', tone: '' } : { text: '"' + nm + '" keeps its last ' + (device === 'keyboard' ? 'key' : 'button') + ': the screens could not be used without it. Bind another one first.', tone: 'bad' }; render(); } }, 'x') : null);
    });
    const addBtn = list.length < MAX_CHIPS ? h('button', { type: 'button', class: 'ip-chip', 'data-fk': (device === 'keyboard' ? 'kb-' : 'pad-') + action + '-add', 'aria-label': 'Add a ' + dv + ' for ' + nm,
      dataset: { add: device, action }, onClick: () => startCapture(device, action, list.length) }, '+ add') : null;
    return h('div', { class: 'ip-chips' }, chips, addBtn);
  }
  function padList() {
    const pads = input.pads;
    if (!pads.length) return h('p', { class: 'ip-dim', dataset: { ip: 'no-pads' } }, 'No controller found. Plug one in or connect it, then press any button on it: browsers keep a controller hidden from a page until a button is pressed.');
    return h('ul', { class: 'ip-pads', 'aria-label': 'Connected controllers' }, pads.map((p) => h('li', { dataset: { pad: p.index, family: p.family, unsupported: p.standard ? '' : '1' } },
      h('strong', null, familyName(p.family)), ' - ', p.id || 'unnamed controller', ' - ',
      p.standard ? 'standard layout (face buttons: ' + (p.layout === 'nintendo' ? 'east = confirm' : 'south = confirm') + ')'
        : 'unsupported layout: the buttons below are a best guess. Use the controller column to bind each action yourself.')));
  }
  function readoutText() {
    const parts = [];
    parts.push(last.source ? SOURCE_NAMES[last.source] : 'nothing yet');
    if (last.raw) parts.push(last.raw.label);
    if (last.action) parts.push('-> ' + ACTION_LABELS[last.action]);
    return 'Last input: ' + parts.join(' ');
  }
  function paintReadout() {
    const el = container.querySelector('[data-ip="readout"]');
    if (!el) return;
    el.textContent = readoutText();
    el.dataset.source = last.source || ''; el.dataset.raw = last.raw ? String(last.raw.value) : ''; el.dataset.action = last.action || '';
  }
  function render(focusKey) {
    if (destroyed) return;
    const active = doc.activeElement;
    let fk = focusKey || (active && container.contains(active) ? active.getAttribute('data-fk') : null);
    const layout = input.bindings.layout();
    const detected = padFamilyNow();
    const layoutBtn = (id, text, desc) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(layout === id), 'data-fk': 'layout-' + id, 'aria-label': text + '. ' + desc,
      onClick: () => { input.bindings.setLayout(id); status = { text: 'Controller layout: ' + text + '.', tone: 'good' }; render(); } }, text);
    const rows = ACTIONS.map((a) => h('tr', { dataset: { action: a } },
      h('th', { scope: 'row' }, ACTION_LABELS[a]),
      h('td', { 'data-label': 'Keyboard' }, cell('keyboard', a)),
      h('td', { 'data-label': 'Controller' }, cell('gamepad', a))));
    const st = input.bindings.status();
    const root = h('section', { class: 'ip', 'aria-labelledby': 'ip-title', dataset: { ip: 'panel' } },
      h('h2', { id: 'ip-title' }, 'Controls'),
      h('p', { class: 'ip-dim' }, 'Keyboard, mouse, touch and controller all work on every screen, and you can switch between them at any time. Change a key or button below by choosing it and pressing the new one.'),
      h('p', { class: 'ip-dim', dataset: { ip: 'mute-key' } }, 'The M key mutes and unmutes the sound on every page (the Sound button opens the volume panel). M is not one of the twelve actions; a key you bind to an action is left alone.'),
      h('p', { class: 'ip-dim', dataset: { ip: 'pad-escape' } }, 'If a controller stops working after a change here: hold Start and Select together for 2 seconds anywhere in the game and its buttons go back to the defaults.'),
      h('div', { class: 'ip-readout', dataset: { ip: 'readout' }, 'aria-live': 'off' }, readoutText()),
      h('p', { class: 'ip-status', role: 'status', 'aria-live': 'polite', dataset: { ip: 'status', tone: status.tone } }, status.text),
      cap ? h('div', { class: 'ip-row' }, h('button', { type: 'button', 'data-fk': 'cancel', dataset: { ip: 'cancel' }, onClick: () => input.cancelCapture() }, 'Cancel')) : null,
      conflict ? h('div', { class: 'ip-conflict', role: 'group', 'aria-label': 'Resolve the conflict', dataset: { ip: 'conflict' } },
        h('strong', null, conflict.label + ' is also used for ' + conflict.others.map((a) => '"' + ACTION_LABELS[a] + '"').join(' and ') + '.'),
        h('div', { class: 'ip-row' },
          h('button', { type: 'button', 'data-fk': 'cf-swap', dataset: { ip: 'swap' }, onClick: () => resolve('swap') }, 'Swap them'),
          h('button', { type: 'button', 'data-fk': 'cf-move', dataset: { ip: 'move' }, onClick: () => resolve('move') }, 'Use it here only'),
          h('button', { type: 'button', 'data-fk': 'cf-cancel', dataset: { ip: 'cf-cancel' }, onClick: () => resolve('cancel') }, 'Cancel'))) : null,
      h('div', { class: 'ip-row', role: 'group', 'aria-label': 'Reset controls' },
        h('button', { type: 'button', class: 'ip-reset', 'data-fk': 'reset-kb', dataset: { ip: 'reset-keyboard' }, onClick: () => doReset('keyboard') }, 'Reset keyboard'),
        h('button', { type: 'button', class: 'ip-reset', 'data-fk': 'reset-pad', dataset: { ip: 'reset-gamepad' }, onClick: () => doReset('gamepad') }, 'Reset controller'),
        h('button', { type: 'button', class: 'ip-reset', 'data-fk': 'reset-all', dataset: { ip: 'reset-all' }, onClick: () => doReset('all') }, 'Reset all')),
      h('h3', null, 'Connected controllers'),
      padList(),
      h('h3', { id: 'ip-layout-h' }, 'Controller button layout'),
      h('div', { class: 'ip-seg', role: 'radiogroup', 'aria-labelledby': 'ip-layout-h' },
        layoutBtn('auto', 'Automatic (' + familyName(detected) + ')', 'Picks the layout from the controller that is connected'),
        layoutBtn('xbox', 'Xbox / PlayStation', 'The bottom button confirms and the right button goes back'),
        layoutBtn('nintendo', 'Nintendo', 'The right button confirms and the bottom button goes back, as on the console')),
      h('h3', null, 'Keys and buttons'),
      h('table', { 'aria-label': 'Controls' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Action'), h('th', { scope: 'col' }, 'Keyboard'), h('th', { scope: 'col' }, 'Controller'))), h('tbody', null, rows)),
      h('p', { class: 'ip-dim', dataset: { ip: 'storage' } }, st.status === 'absent' || !st.persisted && st.status !== 'default' && st.status !== 'loaded'
        ? 'Changes last until you close this page (this browser is not letting the page save settings).' : 'Changes are saved in this browser.'));
    container.replaceChildren(root);
    if (fk) {
      const el = container.querySelector('[data-fk="' + fk + '"]') || container.querySelector('[data-fk="' + fk.replace(/-\d+$/, '-add') + '"]') || container.querySelector('[data-fk="reset-kb"]');
      if (el) { try { el.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    }
  }

  offs.push(
    input.on('raw', (ev) => { last.raw = ev; last.source = ev.device; paintReadout(); }),
    input.on('action', (ev) => { if (ev.pressed && !ev.repeat) { last.action = ev.action; last.source = ev.source; paintReadout(); } }),
    input.on('source', (ev) => { last.source = ev.source; last.raw = null; last.action = null; paintReadout(); }),
    input.on('device', () => { if (!cap) render(); }),
    input.on('bindings', () => { if (!cap) render(); }),
    input.on('capture', (ev) => {
      if (ev.state === 'rejected') setStatus(ev.message, 'bad');
    }));
  render();

  return {
    refresh: () => render(),
    destroy() {
      if (destroyed) return;
      if (cap) input.cancelCapture();
      destroyed = true; stopTimer();
      for (const o of offs.splice(0)) o();
      container.replaceChildren();
    },
    el: container,
  };
}
