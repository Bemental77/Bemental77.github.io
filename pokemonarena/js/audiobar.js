// pokemonarena/js/audiobar.js -- the AUDIO BAR: a volume slider that is always on screen, a mute button, and (on the menu pages) the music changer. ONE module and ONE
// stylesheet (audiobar.css) for the hub, the battle page and the team editor, so "the same everywhere" is true by construction: each page's header carries the same empty
// <div id="audioBar" class="audiobar" data-page="..." data-pending="1"> (it reserves the space, so nothing jumps when this fills it in) and the sound system (sound_system.js)
// hydrates it as soon as the page's mixer exists.
//
//   [ mute ]  [ ----o------ ]  70%  [ music ]        mute / unmute        master volume (the SAME mixer setting the Sound panel's Master slider moves)        menu music
//
//   * The slider and the mute button drive the page's one mixer (audio_mixer.js): the same stored setting as the Sound panel, so moving either moves the other, a reload keeps it,
//     the M key and another tab are followed. Moving the slider up while muted unmutes (nobody drags a volume slider to stay silent).
//   * A click, tap or key on the bar is a user activation like any other: the mixer's own listeners (audio_mixer.js attach, on the window in the capture phase) start the sound BEFORE the bar's
//     handlers run. The bar still calls mixer.unlock() itself (harmless once the context exists) for an activation that arrives with no pointer or key event first, such as a screen reader's click.
//   * FOCUS. After a POINTER use of the bar (a click on mute or on the music button that closes the list, a slider released) focus goes back to the page's input target (`[data-input-target]`: the
//     hub's and the battle page's canvas) or, on a page with none (the team editor), the control is blurred; otherwise the arrow keys would keep moving the slider and Enter / Space would keep
//     toggling mute instead of acting on the game (input.js leaves a focused range its arrows and a focused button its Enter). KEYBOARD use keeps the focus where the keyboard user put it
//     (Esc closes the list and returns to the music button, the usual dialog rule).
//   * The music changer (hub and editor only; the battle page picks its music by the battle) is a small popover: previous / next, Automatic (the game's own song for each menu),
//     every song menu_music.js can play on the soundtrack in use, and Off (no music; the menus keep their sound effects). The choice is stored (menu_music.js) and applies to every menu page.
//   * THE LIST IS A MODAL DIALOG (role="dialog" aria-modal="true"). While it is open every key typed in it belongs to it: the arrows, the keys the player's bindings give the d-pad (W A S D by default:
//     "arrows or WASD move" holds here too) and Home / End pick songs, Tab stays inside, Esc closes, and every other key (Z, X, Backspace, PageUp / PageDown ...) is kept from the page behind it
//     (stopPropagation; Enter and Space still press the focused button natively; M still reaches the global mute shortcut). A CONTROLLER: the hub's own input is told through sys.menuDialog (its dialog
//     counter), because a controller press does not come through a key event, so it ignores the pad while the list is open; the list then gets a navigation layer of its own (sys.dialogNav, only where
//     the page has none over the whole page: the hub): the d-pad moves through it, A picks the focused song, B closes it and gives the focus back to the music button. On the team editor aria-modal makes
//     the page's own uinav.js scope the d-pad and Tab to the list and B close it (sys.dialogNav is null there).
//   * LAYOUT, one rule per size (audiobar.css): wide screens carry the bar inline in the header; a portrait phone gives it a row of its own under the header (the battle page keeps it in
//     the header's first row, which has the room); a phone held sideways in fullscreen has no header, so the bar folds into a speaker button next to the exit-fullscreen button and
//     opens on a tap. This file only moves the element between the header and the page (place()); the CSS does the sizing.
//
// Import-safe in Node: nothing touches window/document at import.

import { toPercent, fromPercent, VOLUME_STEP } from './audio_mixer.js';

export const BAR_ID = 'audioBar';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_DIR = Object.freeze({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' });
const ICONS = {
  on: ['M4 9v6h4l5 4V5L8 9H4z', 'M16.2 9.2a4 4 0 0 1 0 5.6', 'M18.8 6.6a8 8 0 0 1 0 10.8'],
  off: ['M4 9v6h4l5 4V5L8 9H4z', 'M17 9.5l5 5', 'M22 9.5l-5 5'],
  note: ['M9 18V6l10-2v12', 'circle:7,18,2.6', 'circle:17,16,2.6'],
};

function icon(doc, kind, cls) {
  const s = doc.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ab-ic ' + (cls || '')); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
  for (const d of ICONS[kind]) {
    if (d.startsWith('circle:')) { const [cx, cy, r] = d.slice(7).split(','); const c = doc.createElementNS(SVG_NS, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r); s.appendChild(c); }
    else { const p = doc.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
  }
  return s;
}
function h(doc, tag, attrs, ...kids) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined) n.append(c);
  return n;
}

/**
 * Hydrate the page's audio bar.
 *   sys   the sound system (sound_system.js): sys.mixer (volume / mute), sys.menuMusic (the changer; absent = no changer), sys.page, sys.toast
 *   host  the header element (default #top); the bar lives in it, before the Sound button's group, unless the page is in landscape fullscreen
 * -> { el, place, paint, openMenu, closeMenu, state, destroy }
 */
export function mountAudioBar({ doc, win, sys, host }) {
  if (!doc || !sys || !sys.mixer) throw new Error('mountAudioBar needs a document and a sound system');
  const mixer = sys.mixer;
  const page = sys.page || 'page';
  const mm = page === 'battle' ? null : (sys.menuMusic || null);         // the battle page picks its music by the battle: no changer there
  const header = host || doc.getElementById('top');
  let el = doc.getElementById(BAR_ID);
  const adopted = !!el;
  if (!el) {
    el = h(doc, 'div', { id: BAR_ID, class: 'audiobar' });
    if (header) {
      const sb = doc.getElementById('soundBtn');
      const anchor = sb ? (sb.closest('.tools') && sb.closest('.tools').parentNode === header ? sb.closest('.tools') : (sb.parentNode === header ? sb : null)) : null;
      header.insertBefore(el, anchor);
    } else (doc.body || doc.documentElement).appendChild(el);
  }
  el.replaceChildren();
  el.className = 'audiobar'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Sound'); el.dataset.page = page; el.dataset.music = mm ? '1' : '0';
  el.removeAttribute('data-pending');
  const home = { parent: el.parentNode, next: el.nextSibling };

  /* ------------------------------------------------------------------------------- the parts */
  const fold = h(doc, 'button', { type: 'button', class: 'ab-btn ab-fold', id: 'abFold', 'aria-label': 'Sound controls', 'aria-expanded': 'false', title: 'Sound controls' }, icon(doc, 'on'));
  const mute = h(doc, 'button', { type: 'button', class: 'ab-btn ab-mute', id: 'abMute', 'aria-pressed': 'false', 'aria-label': 'Mute', title: 'Mute (M)' }, icon(doc, 'on', 'ab-ic-on'), icon(doc, 'off', 'ab-ic-off'));
  let touch = null;                                                  // { x0, moved } while a finger is down on the slider (see sound_panel.js: a finger that scrolls the page must not set the volume)
  const range = h(doc, 'input', { type: 'range', class: 'ab-vol', id: 'abVolume', min: 0, max: 100, step: VOLUME_STEP, value: toPercent(mixer.volume('master')), 'aria-label': 'Volume', title: 'Volume' });
  const out = h(doc, 'output', { class: 'ab-val', for: 'abVolume', 'aria-hidden': 'true' }, toPercent(mixer.volume('master')) + '%');
  const parts = h(doc, 'div', { class: 'ab-parts' }, mute, range, out);
  let music = null, menu = null, nowEl = null, listEl = null, hintEl = null, menuOpen = false, offDoc = null, menuNav = null;
  if (mm) {
    music = h(doc, 'button', { type: 'button', class: 'ab-btn ab-music', id: 'abMusic', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Menu music', title: 'Menu music' }, icon(doc, 'note'));
    parts.append(music);
  }
  el.append(fold, parts);

  /* ------------------------------------------------------------------------------- volume + mute */
  const setVolumeFrom = (percent) => {
    const v = fromPercent(percent);
    if (mixer.muted() && v > 0) { mixer.unlock(); mixer.setMuted(false); }       // dragging the volume up while muted brings the sound back
    mixer.setVolume('master', v);
    paint();
  };
  range.addEventListener('input', () => { if (touch && !touch.moved) return; setVolumeFrom(range.value); });
  range.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') touch = { x0: e.clientX, moved: false }; });
  range.addEventListener('pointermove', (e) => { if (touch && !touch.moved && Math.abs(e.clientX - touch.x0) > 8) { touch.moved = true; setVolumeFrom(range.value); } });
  range.addEventListener('pointerup', () => { if (touch) { const was = touch; touch = null; if (!was.moved) setVolumeFrom(range.value); } });
  range.addEventListener('pointercancel', () => { if (touch) { touch = null; paint(); } });
  // a slider released with a pointer (mouse, finger, pen; or a touch that turned into a scroll) gives the keyboard back to the page; arrow keys on a focused slider are untouched
  for (const t of ['pointerup', 'pointercancel']) range.addEventListener(t, () => { setTimeout(handBack, 0); });
  mute.addEventListener('click', (e) => {
    mixer.unlock(); mixer.toggleMuted(); paint();
    if (typeof sys.toast === 'function') sys.toast(mixer.muted() ? 'Sound muted (M)' : 'Sound on (M)');
    if (e.detail > 0) handBack(); // a pointer click (detail > 0) gives the keyboard back to the page; Enter / Space on the focused button (detail 0) keep their place
  });
  fold.addEventListener('click', () => { const open = !el.classList.contains('ab-open'); el.classList.toggle('ab-open', open); fold.setAttribute('aria-expanded', String(open)); if (!open) closeMenu(); });

  function paint() {
    const muted = mixer.muted(), p = toPercent(mixer.volume('master'));
    el.dataset.muted = String(muted);
    mute.setAttribute('aria-pressed', String(muted)); mute.title = muted ? 'Unmute (M)' : 'Mute (M)';
    if (String(range.value) !== String(p)) range.value = String(p);
    range.setAttribute('aria-valuetext', p + ' percent' + (muted ? ', muted' : ''));
    out.textContent = p + '%';
    paintMusic();
  }
  const offMixer = mixer.on((ev) => { if (ev.type === 'volume' || ev.type === 'mute' || ev.type === 'soundtrack') paint(); });

  /* ------------------------------------------------------------------------------- the music changer */
  // What the button, the list's "now" line and the screen reader say. The player's pick is shown by NAME (menu_music.js state().pickName: known before the song table loads); a stored pick the
  // soundtrack in use lacks (state().missing) is said so, because the screen's own song is what plays: "Automatic (Battle: rival is not on this soundtrack)".
  const labelOfPick = (st) => { const n = st.pickName || st.pick; return st.missing ? 'Automatic (' + n + ' is not on this soundtrack)' : n; };
  function paintMusic() {
    if (!mm || !music) return;
    const st = mm.state();
    const name = labelOfPick(st);
    music.title = 'Menu music: ' + name; music.setAttribute('aria-label', 'Menu music: ' + name);
    el.dataset.pick = st.pick;
    if (!menu) return;
    nowEl.textContent = name;
    const shown = st.missing ? 'auto' : st.pick;                           // a pick that is not on this soundtrack plays the screen's own song, which is what Automatic is
    for (const b of listEl.querySelectorAll('[role="radio"]')) b.setAttribute('aria-checked', String(b.dataset.pick === shown));
    hintEl.textContent = mixer.muted() ? 'Sound is muted. Unmute to hear the music.' : st.missing ? 'Your pick is not on this soundtrack, so the menu plays its own song.' : st.options.length ? '' : 'The song list is still loading.';
  }
  let renderedKeys = '';
  function buildList() {
    const st = mm.state();
    renderedKeys = st.options.map((o) => o.key).join();
    listEl.replaceChildren();
    const row = (pick, text, title) => listEl.append(h(doc, 'button', { type: 'button', role: 'radio', class: 'ab-opt', 'aria-checked': 'false', dataset: { pick }, title: title || null, text }));
    row('auto', 'Automatic: the game\'s own song for each menu', 'The hub and the team editor each play the song the game gives them');
    for (const o of st.options) row(o.key, o.name);
    row('off', 'Off: no music on the menus', 'No music on the menus (their sound effects and the battle music are not affected)');
  }
  function onListClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('[role="radio"]') : null;
    if (!b || !listEl.contains(b)) return;
    mm.choose(b.dataset.pick); paint();
  }
  function ensureMenu() {
    if (menu) return;
    nowEl = h(doc, 'span', { class: 'ab-now', 'aria-live': 'polite' });
    listEl = h(doc, 'div', { class: 'ab-list', role: 'radiogroup', 'aria-label': 'Menu music' });
    hintEl = h(doc, 'p', { class: 'ab-hint', role: 'status', 'aria-live': 'polite' });
    const stepBtn = (dir, glyph, label) => h(doc, 'button', { type: 'button', class: 'ab-btn ab-step', dataset: { dir: String(dir) }, 'aria-label': label, title: label, text: glyph });
    const prev = stepBtn(-1, '‹', 'Previous song'), next = stepBtn(1, '›', 'Next song');
    for (const b of [prev, next]) b.addEventListener('click', () => { mm.step(Number(b.dataset.dir)); paint(); });
    // a modal dialog: aria-modal makes uinav.js (the team editor's controller layer) scope the d-pad and Tab to it; tabindex -1 keeps a click on its non-interactive parts INSIDE it (focus on the dialog itself)
    menu = h(doc, 'div', { id: 'abMenu', class: 'ab-menu', role: 'dialog', 'aria-modal': 'true', tabindex: '-1', 'aria-label': 'Menu music', hidden: true },
      h(doc, 'div', { class: 'ab-menu-head' }, prev, nowEl, next), listEl, hintEl);
    listEl.addEventListener('click', onListClick);
    menu.addEventListener('keydown', onMenuKey);
    (doc.body || doc.documentElement).appendChild(menu);
  }
  function placeMenu() {
    if (!menu || !music || !win) return;
    const r = music.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = win.innerHeight;
    const top = Math.min(r.bottom + 6, Math.max(8, vh - 120));
    menu.style.top = top + 'px'; menu.style.right = Math.max(8, vw - r.right) + 'px'; menu.style.maxHeight = Math.max(120, vh - top - 10) + 'px';
  }
  function openMenu() {
    if (!mm || menuOpen) return false;
    ensureMenu(); buildList(); paint();
    menu.hidden = false; menuOpen = true; music.setAttribute('aria-expanded', 'true'); el.dataset.menu = 'open';
    if (typeof sys.menuDialog === 'function') sys.menuDialog(true);        // the page stops acting on its own input while the list is open (the hub's dialog counter)
    placeMenu();
    const checked = listEl.querySelector('[aria-checked="true"]') || listEl.querySelector('[role="radio"]');
    try { checked && checked.focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
    // A CONTROLLER (see the header): where the page has no navigation layer over the list, give the list one. The hub ignores the pad while the list is up (sys.menuDialog above), so without this
    // a player who opened the list with the mouse and then picked up the pad could only close it with Esc or a click. B finds no close button in the list and sends it the synthetic Escape below.
    try { menuNav = typeof sys.dialogNav === 'function' ? sys.dialogNav(menu, () => closeMenu(true)) : null; } catch (_e) { menuNav = null; }
    // outside press, and a repaint when the songs arrive or the soundtrack changes
    const onDown = (e) => { if (menu.contains(e.target) || el.contains(e.target)) return; closeMenu(); };
    doc.addEventListener('pointerdown', onDown, true);
    // Esc closes from wherever the focus is (not only from inside the list)
    const onKey = (e) => { if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); closeMenu(true); } };
    doc.addEventListener('keydown', onKey, true);
    // the songs arrive late, or the soundtrack changes: rebuild the list. A pick alone only repaints: rebuilding would throw away the entry that has the focus.
    const offMM = mm.on(() => { if (!menuOpen) return; if (mm.state().options.map((o) => o.key).join() !== renderedKeys) { buildList(); placeMenu(); } paint(); });
    offDoc = () => { doc.removeEventListener('pointerdown', onDown, true); doc.removeEventListener('keydown', onKey, true); offMM(); };
    return true;
  }
  function closeMenu(refocus) {
    if (!menuOpen) return false;
    menuOpen = false; menu.hidden = true; music.setAttribute('aria-expanded', 'false'); delete el.dataset.menu;
    if (offDoc) { offDoc(); offDoc = null; }
    if (menuNav) { try { menuNav.disable(); } catch (_e) { /* ignore */ } menuNav = null; }
    if (typeof sys.menuDialog === 'function') sys.menuDialog(false);
    if (refocus) { try { music.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    return true;
  }
  // The keys of the list (it is modal, see the header). The arrows, and the keys bound to the d-pad (WASD), move through the songs and PICK them (a radio group); Tab stays inside; Esc is handled in openMenu (document capture). EVERY OTHER key
  // is kept from the page behind the list: input.js listens on the window, so stopping the event here is enough to keep Z / X / Backspace / PageUp / PageDown (and the direction keys, which the list has taken for itself) from driving the hub or the
  // editor. No preventDefault on those: Enter and Space must still press the focused button natively. M is left alone on purpose: it is the global mute shortcut (sound_system.js, on the document).
  function onMenuKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const radios = Array.from(listEl.querySelectorAll('[role="radio"]'));
    const onRadio = radios.indexOf(doc.activeElement);
    const move = (i) => { const n = radios[(i + radios.length) % radios.length]; if (n) { n.focus({ preventScroll: true }); mm.choose(n.dataset.pick); paint(); } };
    // THE DIRECTION KEYS: the four arrows, and whichever keys the player's bindings give the d-pad (W A S D by default, input.js; sys.keyDirection asks the input layer, so a rebinding is followed). They
    // pick songs exactly like the arrows -- the rest of the game promises "arrows or WASD move" -- and, like every key typed in the list, they never reach the page behind it.
    const dir = ARROW_DIR[e.key] || (typeof sys.keyDirection === 'function' ? sys.keyDirection(e) : null);
    if (dir === 'down' || dir === 'right') { e.preventDefault(); e.stopPropagation(); if (onRadio >= 0) move(onRadio + 1); else if (radios[0]) radios[0].focus({ preventScroll: true }); }
    else if (dir === 'up' || dir === 'left') { e.preventDefault(); e.stopPropagation(); if (onRadio >= 0) move(onRadio - 1); else if (radios[radios.length - 1]) radios[radios.length - 1].focus({ preventScroll: true }); }
    else if (e.key === 'Home' && onRadio >= 0) { e.preventDefault(); e.stopPropagation(); move(0); }
    else if (e.key === 'End' && onRadio >= 0) { e.preventDefault(); e.stopPropagation(); move(radios.length - 1); }
    else if (e.key === 'Tab') {
      const f = Array.from(menu.querySelectorAll('button')).filter((b) => !b.disabled && b.getClientRects().length > 0);
      const a = doc.activeElement;
      if (f.length) {
        if (e.shiftKey && (a === f[0] || a === menu || !menu.contains(a))) { e.preventDefault(); f[f.length - 1].focus({ preventScroll: true }); }
        else if (!e.shiftKey && (a === f[f.length - 1] || !menu.contains(a))) { e.preventDefault(); f[0].focus({ preventScroll: true }); }
      }
    }
    else if (e.key === 'Escape' || e.code === 'KeyM' || e.key === 'm' || e.key === 'M') { /* Esc closed the list already (document capture); M reaches the mute shortcut */ }
    else e.stopPropagation();
  }
  // After a pointer use of the bar the keyboard goes back to the page (header: FOCUS). While the list is open the focus belongs inside it, so it returns to the checked song instead.
  function handBack() {
    try {
      if (menuOpen && menu) { const c = listEl.querySelector('[aria-checked="true"]') || listEl.querySelector('[role="radio"]'); if (c && !menu.contains(doc.activeElement)) c.focus({ preventScroll: true }); return true; }
      const t = doc.querySelector('[data-input-target]');
      if (t && !t.hidden && typeof t.focus === 'function') { t.focus({ preventScroll: true }); return true; }
      const a = doc.activeElement;
      if (a && a !== doc.body && el.contains(a) && typeof a.blur === 'function') { a.blur(); return true; }
    } catch (_e) { /* focus is a nicety, never a failure */ }
    return false;
  }
  if (music) {
    music.addEventListener('click', (e) => { if (menuOpen) { closeMenu(true); if (e.detail > 0) handBack(); } else { mixer.unlock(); openMenu(); } });
    music.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !menuOpen) { e.preventDefault(); e.stopPropagation(); mixer.unlock(); openMenu(); } });
  }
  const offMM2 = mm ? mm.on(() => paint()) : null;

  /* ------------------------------------------------------------------------------- where it lives */
  // A phone held sideways in fullscreen has no header (the page hides it): the bar then leaves it and floats beside the exit-fullscreen button, folded to one speaker button.
  function place() {
    const b = doc.body;
    const floating = !!b && b.dataset.full === '1' && b.dataset.layout === 'landscape';
    const inHeader = el.parentNode === home.parent;
    if (floating && inHeader) {
      closeMenu();
      b.appendChild(el); el.classList.add('ab-float'); el.classList.remove('ab-open'); fold.setAttribute('aria-expanded', 'false');
    } else if (!floating && !inHeader) {
      closeMenu();
      el.classList.remove('ab-float', 'ab-open'); fold.setAttribute('aria-expanded', 'false');
      const nx = home.next && home.next.parentNode === home.parent ? home.next : null;
      home.parent.insertBefore(el, nx);
    } else return false;
    // the header's height changed: the page fits its picture to the room that is left
    if (win && typeof win.dispatchEvent === 'function' && typeof win.Event === 'function') { try { win.dispatchEvent(new win.Event('resize')); } catch (_e) { /* ignore */ } }
    return true;
  }
  let mo = null;
  if (win && typeof win.MutationObserver === 'function' && doc.body) {
    mo = new win.MutationObserver(() => place());
    mo.observe(doc.body, { attributes: true, attributeFilter: ['data-full', 'data-layout'] });
  }
  const onResize = () => { if (menuOpen) placeMenu(); };
  if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);
  // Esc closes the open song list from anywhere, and folds the floating bar
  const onDocKey = (e) => { if (e.key === 'Escape' && el.classList.contains('ab-open') && el.classList.contains('ab-float')) { el.classList.remove('ab-open'); fold.setAttribute('aria-expanded', 'false'); try { fold.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } };
  doc.addEventListener('keydown', onDocKey);

  paint();
  place();

  function destroy() {
    offMixer(); if (offMM2) offMM2(); closeMenu();
    if (mo) mo.disconnect();
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', onResize);
    doc.removeEventListener('keydown', onDocKey);
    if (menu && menu.remove) menu.remove();
    if (adopted) { el.replaceChildren(); el.dataset.pending = '1'; } else if (el.remove) el.remove();
  }
  return {
    el, place, paint, openMenu, closeMenu, destroy,
    state: () => ({ page, music: !!mm, menuOpen, floating: el.classList.contains('ab-float'), open: el.classList.contains('ab-open'), muted: mixer.muted(), volume: toPercent(mixer.volume('master')), pick: mm ? mm.pick() : null }),
  };
}
