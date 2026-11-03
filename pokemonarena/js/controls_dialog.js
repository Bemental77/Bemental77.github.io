// pokemonarena/js/controls_dialog.js -- the ONE way every page opens the Controls panel (input_panel.js) as a modal dialog.
//
// The hub, the battle page and the team editor all show the same panel in the same dialog, closed the same way (Close, B, Esc, or a click on
// the dimmed backdrop), driven by every input device (it is plain DOM; uinav.js moves focus with a keyboard or controller, a mouse or finger
// just clicks). Browser module; nothing touches `document` at import time.
//
//   const dlg = createControlsDialog({ input, enableDomNav, onClose });   // enableDomNav from uinav.js; input from input.js
//   dlg.open();  dlg.close();  dlg.isOpen();  dlg.el                      // el = the [role=dialog] element
//
// opts.el        an existing dialog element (the hub's #controlsDialog); otherwise one is created and appended to <body>
// opts.ownNav    true (default): the dialog runs its own enableDomNav on itself (pages with no global navigation: the hub, the battle page).
//                false: the page already runs enableDomNav on a larger root (the editor); an aria-modal dialog confines it by itself.
// opts.onOpen / opts.onClose   called after the dialog opened / closed (the battle page pauses its clock and ignores actions meanwhile)
//
// The styling is injected once (id arena-controls-style) from custom properties with fallbacks, so a page need not load arena.css.

const STYLE_ID = 'arena-controls-style';
const CSS = `
.arena-ctl { position: fixed; inset: 0; z-index: 2000; background: rgba(0, 0, 0, .72); display: flex; align-items: flex-start; justify-content: center; overflow-y: auto; padding: max(12px, env(safe-area-inset-top)) var(--gutter, 16px) 24px; }
.arena-ctl[hidden] { display: none !important; }
.arena-ctl .dlg { max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); display: flex; flex-direction: column; overflow: hidden; width: min(100%, 640px); background: var(--panel, #1a1a1f); color: var(--fg, #ddd); border: 1px solid var(--line, #3a3a44); border-radius: 10px; padding: 14px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.arena-ctl h2 { margin: 0; font-size: 18px; }
.arena-ctl .dlg-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: -14px -14px 10px; padding: 10px 14px; background: var(--panel, #1a1a1f); border-bottom: 1px solid var(--line, #3a3a44); border-radius: 10px 10px 0 0; }
/* W1 fix D8: the dialog fits the screen and its CONTENT scrolls (it used to be 3039 px tall on a phone); the panel's own heading repeats the dialog's, so it stays for screen readers only */
.arena-ctl #controlsHost, .arena-ctl [data-controls-host] { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.arena-ctl .ip > h2 { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.arena-ctl .dlg > .row { flex: 0 0 auto; }
.arena-ctl .row { display: flex; justify-content: flex-end; margin-top: 12px; }
.arena-ctl .ctl-close { font: inherit; color: var(--fg, #ddd); background: var(--btn, #222); border: 1px solid var(--line, #3a3a44); border-radius: 6px; min-height: 44px; min-width: 44px; padding: 8px 18px; font-size: 14px; cursor: pointer; }
.arena-ctl .ctl-close:hover { background: var(--btn-hi, #333); }
`;

export function createControlsDialog(opts = {}) {
  const input = opts.input;
  const doc = opts.document || document;
  if (!input || !input.bindings) throw new Error('createControlsDialog({ input }) needs an input layer');
  const ownNav = opts.ownNav !== false;
  let el = opts.el || null;
  let host = null, closeBtn = null, panel = null, nav = null, open = false, wired = false, opener = null;

  function build() {
    if (!doc.getElementById(STYLE_ID)) { const st = doc.createElement('style'); st.id = STYLE_ID; st.textContent = CSS; (doc.head || doc.documentElement).appendChild(st); }
    if (!el) {
      el = doc.createElement('div');
      el.id = 'controlsDialog'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'ctlTitle'); el.hidden = true;
      el.innerHTML = '<div class="dlg"><div class="dlg-head"><h2 id="ctlTitle">Controls</h2><button id="controlsClose" class="ctl-close" type="button" data-nav-close>Close</button></div><div id="controlsHost"></div><div class="row"><button id="controlsClose2" class="ctl-close" type="button" data-nav-close>Close</button></div></div>';
      (doc.body || doc.documentElement).appendChild(el);
    }
    el.classList.add('arena-ctl');
    host = el.querySelector('#controlsHost') || el.querySelector('[data-controls-host]');
    closeBtn = el.querySelector('#controlsClose') || el.querySelector('[data-nav-close]');
    if (!wired) {
      wired = true;
      for (const b of el.querySelectorAll('[data-nav-close]')) b.addEventListener('click', close);
      // a click on the dimmed backdrop (not on the panel) closes it, as every other dialog of the game does
      el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
      // an input layer that failed to start cannot deliver B: Escape still closes. Only when THIS dialog owns the page's navigation: a page whose own layer drives the dialog (the editor,
      // ownNav false) closes it through that layer, and a second closer here shut it first and left the same Escape to the page's "B goes up", which threw the player out of the editor
      doc.addEventListener('keydown', (e) => { if (open && ownNav && e.key === 'Escape' && !nav && !(e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) close(); });
    }
  }

  async function openDialog() {
    if (open) return true;
    opener = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;      // the control that opened it gets focus back on close (a pointer-only close would otherwise drop it on the page)
    build();
    try {
      const { mountControlsPanel } = await import('./input_panel.js');
      host.replaceChildren();
      panel = mountControlsPanel(host, { input });
    } catch (e) { console.warn('[controls] the Controls panel could not open', e); return false; }
    el.hidden = false; open = true; doc.body.dataset.dialog = 'open'; el.scrollTop = 0;
    if (ownNav && typeof opts.enableDomNav === 'function') {
      try { nav = opts.enableDomNav(el, { input, onBack: close }); nav.focusFirst(); } catch (_e) { nav = null; }
    }
    el.scrollTop = 0;
    if (!nav) { const first = el.querySelector('[data-nav-default]') || el.querySelector('button, [href], input, select') || closeBtn; try { first && first.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    if (typeof opts.onOpen === 'function') opts.onOpen();
    return true;
  }

  function close() {
    if (!open) return;
    try { if (panel && panel.destroy) panel.destroy(); } catch (_e) { /* ignore */ }
    try { if (nav && nav.disable) nav.disable(); } catch (_e) { /* ignore */ }
    panel = null; nav = null; open = false; el.hidden = true; delete doc.body.dataset.dialog;
    if (host) host.replaceChildren();
    if (opener && opener.isConnected) { try { opener.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    opener = null;
    if (typeof opts.onClose === 'function') opts.onClose();
  }

  return { open: openDialog, close, isOpen: () => open, get el() { return el; } };
}
