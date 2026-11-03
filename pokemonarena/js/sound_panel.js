// pokemonarena/js/sound_panel.js -- the SOUND panel: three volume sliders (Master, Music, Effects and cries), MUTE, the SOUNDTRACK choice
// (SoulGold / Ultra Violet) and a TEST button that plays a cry through the effects bus. The ONE panel every page opens:
//   the hub's SOUND row and header button, the battle page's header button and pause-menu SOUND row, the Team Builder's header button.
//
// It is plain DOM in a modal dialog -- the same way the Controls panel is (controls_dialog.js) -- so each device drives it ALONE:
//   mouse        click or drag a slider (native range input), click the - / + buttons (hold = repeat), wheel over a slider = 5% per notch, click the backdrop to close
//   touch        the same, every target is at least 44 css px; drag the slider with a finger; hold - / + to repeat
//   keyboard     Tab / arrows, a slider takes Left / Right / Home / End / PageUp / PageDown natively (5% steps), Enter / Space press buttons, Esc closes
//   controller   uinav.js: d-pad moves between controls, A on a slider starts adjusting it (Left / Right = 5%, Up / Down = 10%, hold repeats), B finishes, B again closes
//
//   const p = createSoundPanel({ mixer, input, enableDomNav, ownNav, soundtracks, onTest, onOpen, onClose });
//   p.open(done);  p.close();  p.isOpen();  p.refresh();  p.el
//
// opts.input / opts.enableDomNav   optional; without them the panel still works with mouse, touch and keyboard (the Team Builder opens it before its input layer loads)
// opts.ownNav     true (default): this dialog runs its own enableDomNav (hub, battle). false: the page already runs one on a larger root (the Team Builder)
// opts.soundtracks { status() -> { state: 'ready'|'loading'|'error', soundtrack, message, progress }, choose(name) -> Promise<{ok,message}>, labels: {id: text} }
// opts.onTest(kind)   plays the test cry ('button' for the Test button, 'fx' after the Effects slider is released)
//
// The styling is injected once (id arena-sound-style) from custom properties with fallbacks, so a page need not load any stylesheet for it.
// Import-safe in Node: nothing touches `document` until createSoundPanel is called with one.

import { BUSES, VOLUME_STEP, toPercent, fromPercent, SOUNDTRACK_IDS } from './audio_mixer.js';

export const BUS_LABELS = Object.freeze({ master: 'Master', music: 'Music', fx: 'Effects and cries' });
export const SOUNDTRACK_LABELS = Object.freeze({ soulgold: 'SoulGold', ultraviolet: 'Ultra Violet' });
export const HOLD = Object.freeze({ delayMs: 400, intervalMs: 90 });          // the input layer's own repeat timing (input.js TIMING)

/** One step of a percent slider: dir +1 / -1, big = the controller's Up / Down (10). Clamped to 0..100, always a multiple of the step. */
export function stepPercent(cur, dir, big) {
  const step = big ? VOLUME_STEP * 2 : VOLUME_STEP;
  const v = Number(cur) || 0;
  const next = dir < 0 ? Math.ceil(v / step) * step - step : Math.floor(v / step) * step + step;     // from a value off the grid (a hand-edited 33) the next multiple in the direction pressed
  return Math.min(100, Math.max(0, next));
}

const STYLE_ID = 'arena-sound-style';
export const CSS = `
.arena-snd { position: fixed; inset: 0; z-index: 2100; background: rgba(0, 0, 0, .72); display: flex; align-items: flex-start; justify-content: center; overflow-y: auto; padding: max(12px, env(safe-area-inset-top)) var(--gutter, 16px) 24px; }
.arena-snd[hidden] { display: none !important; }
.arena-snd * { box-sizing: border-box; }
.arena-snd .snd-dlg { width: min(100%, 560px); background: var(--panel, #1a1a1f); color: var(--fg, #ddd); border: 1px solid var(--line, #3a3a44); border-radius: 10px; padding: 14px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-size: 14px; line-height: 1.4; }
.arena-snd h2 { margin: 0; font-size: 18px; }
.arena-snd h3 { margin: 16px 0 6px; font-size: 14px; font-weight: 600; color: #cfcfdc; }
.arena-snd .snd-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; position: sticky; top: 0; z-index: 2; margin: -14px -14px 10px; padding: 10px 14px; background: var(--panel, #1a1a1f); border-bottom: 1px solid var(--line, #3a3a44); border-radius: 10px 10px 0 0; }
.arena-snd .snd-note { margin: 6px 0 10px; min-height: 20px; color: var(--dim, #9a9aa8); font-size: 13px; }
.arena-snd .snd-note[data-tone="warn"] { color: var(--warn, #fc8); }
.arena-snd .snd-row { margin: 10px 0; }
.arena-snd .snd-row > label, .arena-snd .snd-label { display: block; font-weight: 600; margin-bottom: 2px; }
.arena-snd .snd-ctl { display: flex; align-items: center; gap: 8px; }
.arena-snd .snd-range { flex: 1 1 auto; min-width: 0; width: 100%; height: 44px; margin: 0; accent-color: var(--accent, #6af); cursor: pointer; touch-action: pan-y; }
.arena-snd .snd-val { flex: 0 0 auto; min-width: 46px; text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, Consolas, monospace; }
.arena-snd button { font: inherit; color: var(--fg, #ddd); background: var(--btn, #222); border: 1px solid var(--line, #3a3a44); border-radius: 8px; min-height: 44px; min-width: 44px; padding: 6px 14px; cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.arena-snd button:hover { background: var(--btn-hi, #333); }
.arena-snd button[aria-pressed="true"], .arena-snd button[aria-checked="true"] { background: #27466f; border-color: var(--accent, #6af); box-shadow: inset 0 -3px 0 var(--accent, #6af); }
.arena-snd button[disabled] { opacity: .5; cursor: not-allowed; }
.arena-snd .snd-step { padding: 0; font-size: 20px; font-weight: 700; }
.arena-snd .snd-seg { display: flex; flex-wrap: wrap; gap: 8px; }
.arena-snd .snd-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.arena-snd .snd-status { margin: 6px 0 0; font-size: 13px; color: var(--dim, #9a9aa8); min-height: 18px; overflow-wrap: anywhere; }
.arena-snd .snd-status[data-state="error"] { color: var(--bad, #f98); }
.arena-snd progress { width: 100%; height: 10px; accent-color: var(--accent, #6af); }
.arena-snd .snd-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.arena-snd .snd-tip { margin: 0; font-size: 12px; color: var(--dim, #9a9aa8); flex: 1 1 200px; }
@media (max-width: 420px) { .arena-snd .snd-dlg { padding: 12px; } .arena-snd .snd-head { margin: -12px -12px 10px; padding: 8px 12px; } }
`;

export function createSoundPanel(opts = {}) {
  const mixer = opts.mixer;
  if (!mixer || typeof mixer.setVolume !== 'function') throw new Error('createSoundPanel({ mixer }) needs the audio mixer');
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('createSoundPanel needs a document');
  const ownNav = opts.ownNav !== false;
  const getInput = () => (typeof opts.input === 'function' ? opts.input() : opts.input) || null;
  const soundtracks = opts.soundtracks || null;
  const offs = [];
  let el = null, nav = null, open = false, done = null, holdTimer = null, holdInt = null, opener = null;
  const refs = {};

  function inject() {
    if (doc.getElementById(STYLE_ID)) return;
    const st = doc.createElement('style'); st.id = STYLE_ID; st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }
  const h = (tag, attrs, ...kids) => {
    const n = doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'dataset') for (const d of Object.keys(v)) n.dataset[d] = v[d];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) { if (c === null || c === undefined || c === false) continue; n.appendChild(c.nodeType ? c : doc.createTextNode(String(c))); }
    return n;
  };

  /* ---- hold-to-repeat on the - / + buttons (pointer devices; a key or controller press is one click per press and the input layer repeats directions itself) ---- */
  function stopHold() { if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; } if (holdInt !== null) { clearInterval(holdInt); holdInt = null; } }
  function nudge(bus, dir, big) { const next = stepPercent(toPercent(mixer.volume(bus)), dir, big); mixer.setVolume(bus, fromPercent(next)); paint(); return next; }
  function stepButton(bus, dir) {
    let handledByPointer = false;
    return h('button', {
      type: 'button', class: 'snd-step', dataset: { snd: (dir < 0 ? 'down-' : 'up-') + bus }, 'aria-label': BUS_LABELS[bus] + (dir < 0 ? ' down' : ' up') + ' by ' + VOLUME_STEP + ' percent',
      onPointerdown: (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        handledByPointer = true; stopHold(); nudge(bus, dir);
        holdTimer = setTimeout(() => { holdInt = setInterval(() => nudge(bus, dir), HOLD.intervalMs); }, HOLD.delayMs);
      },
      onPointerup: () => { stopHold(); },
      onPointerleave: () => { stopHold(); },
      onPointercancel: () => { stopHold(); },
      onClick: () => { if (handledByPointer) { handledByPointer = false; return; } nudge(bus, dir); },       // keyboard / controller: one step per press
    }, dir < 0 ? '−' : '+');
  }

  function sliderRow(bus) {
    const id = 'snd-' + bus;
    let touch = null;                                       // { x0, moved } while a finger is down on this slider
    const range = h('input', {
      type: 'range', id, min: 0, max: 100, step: VOLUME_STEP, value: toPercent(mixer.volume(bus)), class: 'snd-range', dataset: { snd: 'slider-' + bus },
      'aria-label': BUS_LABELS[bus] + ' volume', 'aria-valuetext': toPercent(mixer.volume(bus)) + ' percent', 'data-nav-default': bus === 'master' ? '' : null,
      onInput: (e) => { if (touch && !touch.moved) return; const v = fromPercent(e.target.value); mixer.setVolume(bus, v); paintOne(bus); },       // (a touch that has not yet moved sideways waits: see below)
      onChange: () => { if (touch) return; if (bus === 'fx' && typeof opts.onTest === 'function') opts.onTest('fx'); },       // let go of Effects and hear the level
      // A finger that lands on a slider makes the browser jump the thumb to it AT ONCE; if that finger then drags UP or DOWN it is scrolling the panel (a phone held sideways), and the
      // browser cancels the pointer. So a touch is only applied when it is a tap (pointerup) or has moved sideways; a cancelled one puts the thumb back where the volume really is.
      onPointerdown: (e) => { if (e.pointerType === 'touch') touch = { x0: e.clientX, moved: false }; },
      onPointermove: (e) => { if (touch && !touch.moved && Math.abs(e.clientX - touch.x0) > 8) { touch.moved = true; const v = fromPercent(range.value); mixer.setVolume(bus, v); paintOne(bus); } },
      onPointerup: () => { if (touch) { const was = touch; touch = null; if (!was.moved) { mixer.setVolume(bus, fromPercent(range.value)); paintOne(bus); } if (bus === 'fx' && typeof opts.onTest === 'function') opts.onTest('fx'); } },
      onPointercancel: () => { if (touch) { touch = null; paintOne(bus); } },
    });
    const out = h('output', { class: 'snd-val', for: id, dataset: { snd: 'value-' + bus } }, toPercent(mixer.volume(bus)) + '%');
    refs[bus] = { range, out };
    const row = h('div', { class: 'snd-row', dataset: { bus } },
      h('label', { for: id }, BUS_LABELS[bus]),
      h('div', { class: 'snd-ctl' }, stepButton(bus, -1), range, stepButton(bus, 1), out));
    // wheel over the control: 5% per notch (a trackpad's small deltas accumulate to a notch)
    let acc = 0;
    row.addEventListener('wheel', (e) => {
      if (!e.deltaY) return;
      e.preventDefault(); acc += e.deltaY;
      while (Math.abs(acc) >= 100) { nudge(bus, acc < 0 ? 1 : -1); acc -= Math.sign(acc) * 100; }
    }, { passive: false });
    return row;
  }

  function build() {
    inject();
    for (const k of Object.keys(refs)) delete refs[k];
    el = h('div', { id: 'soundDialog', class: 'arena-snd', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sndTitle', hidden: true, dataset: { sndPanel: '1' } });
    const closeBtn = (id) => h('button', { type: 'button', dataset: { snd: id }, 'data-nav-close': '', onClick: () => api.close() }, 'Close');
    refs.note = h('p', { class: 'snd-note', role: 'status', 'aria-live': 'polite', dataset: { snd: 'note' } });
    refs.mute = h('button', { type: 'button', dataset: { snd: 'mute' }, onClick: () => { mixer.toggleMuted(); paint(); } }, 'Mute');
    refs.test = h('button', { type: 'button', dataset: { snd: 'test' }, onClick: () => { if (typeof opts.onTest === 'function') opts.onTest('button'); } }, 'Play a test cry');
    refs.stStatus = h('p', { class: 'snd-status', role: 'status', 'aria-live': 'polite', dataset: { snd: 'soundtrack-status' } });
    refs.stProgress = h('progress', { max: 1, value: 0, hidden: true, dataset: { snd: 'soundtrack-progress' }, 'aria-label': 'Loading the soundtrack' });
    refs.st = {};
    const seg = h('div', { class: 'snd-seg', role: 'radiogroup', 'aria-labelledby': 'snd-st-h' }, SOUNDTRACK_IDS.map((id) => {
      refs.st[id] = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { snd: 'soundtrack-' + id }, onClick: () => chooseSoundtrack(id) }, (soundtracks && soundtracks.labels && soundtracks.labels[id]) || SOUNDTRACK_LABELS[id] || id);
      return refs.st[id];
    }));
    el.appendChild(h('div', { class: 'snd-dlg' },
      h('div', { class: 'snd-head' }, h('h2', { id: 'sndTitle' }, 'Sound'), closeBtn('close')),
      refs.note,
      BUSES.map((b) => sliderRow(b)),
      h('div', { class: 'snd-row snd-line' }, refs.mute, refs.test),
      h('h3', { id: 'snd-st-h' }, 'Soundtrack'),
      seg, refs.stProgress, refs.stStatus,
      h('div', { class: 'snd-foot' },
        h('p', { class: 'snd-tip' }, 'The M key mutes and unmutes on any page. Every song and sound is read from the ROM in your browser. The starting levels (70 / 60 / 80%) play the music as loud as the real game does.'),
        closeBtn('close2'))));
    // a click on the dimmed backdrop (not on the dialog) closes it, as every other dialog of the game does
    el.addEventListener('mousedown', (e) => { if (e.target === el) api.close(); });
    // Esc closes, from anywhere inside (a slider would otherwise keep the first Esc for itself). preventDefault: the input layer ignores keys an inner component handled.
    el.addEventListener('keydown', (e) => { if (open && e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); api.close(); } });
    (doc.body || doc.documentElement).appendChild(el);
  }

  /* ---- painting from the mixer ---- */
  function paintOne(bus) {
    const r = refs[bus]; if (!r) return;
    const p = toPercent(mixer.volume(bus));
    if (String(r.range.value) !== String(p)) r.range.value = String(p);
    r.range.setAttribute('aria-valuetext', p + ' percent');
    r.out.textContent = p + '%';
  }
  function paint() {
    if (!el) return;
    for (const b of BUSES) paintOne(b);
    const muted = mixer.muted();
    refs.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    refs.mute.textContent = muted ? 'Muted (click to unmute)' : 'Mute';
    const sel = mixer.soundtrack();
    for (const id of Object.keys(refs.st)) refs.st[id].setAttribute('aria-checked', id === sel ? 'true' : 'false');
    const needs = mixer.needsActivation();
    const msg = muted ? 'Sound is muted. Unmute to hear music, effects and cries.' : needs ? 'Sound starts after your first click, tap or key press. A controller button alone cannot start it: that is a browser rule.' : mixer.hidden() ? '' : 'Sound is on.';
    refs.note.textContent = msg; refs.note.dataset.tone = needs && !muted ? 'warn' : '';
    const s = soundtracks && typeof soundtracks.status === 'function' ? soundtracks.status() : null;
    if (s) {
      refs.stStatus.dataset.state = s.state || 'ready';
      refs.stStatus.textContent = s.message || (s.state === 'ready' ? 'Playing the ' + ((soundtracks.labels && soundtracks.labels[sel]) || SOUNDTRACK_LABELS[sel]) + ' soundtrack.' : '');
      const loading = s.state === 'loading';
      refs.stProgress.hidden = !loading;
      if (loading && typeof s.progress === 'number') refs.stProgress.value = Math.max(0, Math.min(1, s.progress));
      for (const id of Object.keys(refs.st)) refs.st[id].disabled = loading;
    }
  }
  async function chooseSoundtrack(id) {
    if (!soundtracks || typeof soundtracks.choose !== 'function') { try { mixer.setSoundtrack(id); } catch (_e) { /* ignore */ } paint(); return; }
    paint();
    try { await soundtracks.choose(id); } catch (_e) { /* status() carries the message */ }
    paint();
  }

  /* ---- open / close ---- */
  async function openPanel(doneCb) {
    if (open) return true;
    if (!el) build();
    opener = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    done = typeof doneCb === 'function' ? doneCb : null;
    paint();
    el.hidden = false; open = true; doc.body.dataset.dialog = 'open'; el.scrollTop = 0;
    offs.push(mixer.on((ev) => { if (ev.type === 'volume' || ev.type === 'mute' || ev.type === 'soundtrack' || ev.type === 'unlock' || ev.type === 'state' || ev.type === 'hidden' || ev.type === 'visible') paint(); }));
    const input = getInput();
    if (ownNav && input && typeof opts.enableDomNav === 'function') {
      try { nav = opts.enableDomNav(el, { input, onBack: api.close }); nav.focusFirst(); } catch (_e) { nav = null; }
    }
    if (!nav) { const first = refs.master && refs.master.range; try { first && first.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    el.scrollTop = 0;
    if (typeof opts.onOpen === 'function') opts.onOpen();
    return true;
  }
  function close() {
    if (!open) return;
    stopHold();
    for (const o of offs.splice(0)) { try { o(); } catch (_e) { /* ignore */ } }
    try { if (nav && nav.disable) nav.disable(); } catch (_e) { /* ignore */ }
    nav = null; open = false; el.hidden = true; delete doc.body.dataset.dialog;
    const d = done; done = null;
    // focus goes back to whatever opened the panel (the header button); a page whose canvas should take the focus does that in onClose, which runs after
    if (opener && opener.isConnected) { try { opener.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    opener = null;
    if (typeof opts.onClose === 'function') { try { opts.onClose(); } catch (_e) { /* a page callback must not break closing */ } }
    if (d) { try { d(); } catch (_e) { /* a page callback must not break closing */ } }
  }

  const api = {
    open: openPanel, close, isOpen: () => open, refresh: paint,
    get el() { return el; },
    // test seam: the exact values the UI shows
    view: () => ({ open, values: Object.fromEntries(BUSES.map((b) => [b, refs[b] ? Number(refs[b].range.value) : null])), muted: refs.mute ? refs.mute.getAttribute('aria-pressed') === 'true' : null }),
  };
  return api;
}
