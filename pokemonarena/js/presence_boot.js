// pokemonarena/js/presence_boot.js -- the page half of OPEN TO BATTLES (presence.js has the rules): the switch in the hub's footer and in a CPU battle's header, the board connection, the trainer's
// name and record read from their profile, the first-time disclosure, and the "<name> wants to battle you" dialog. The hub mounts it once the menu is ready; a battle against the CPU mounts it
// too, ALWAYS: while the switch is off it is dormant (no board connection, no dialog in the page; it only draws the header's Open button and listens for the switch going on in another tab),
// so a challenge reaches you in the hub and in a CPU battle, and a CPU battle opened before the switch went on follows it (the online pages and the team builder do not mount it: the online
// pages are already the place people meet).
//
//   const p = mountPresence({ win, doc, pack, input, enableDomNav, navigate, button, buttonText, focusHome, onDialog: { open(which), close(which) } });
//   p.setOn(true)  p.isOn()  p.refresh()  p.dispose()                     // window.__arenaPresence while mounted (test hook)
//
// WHAT IT PUBLISHES, AND TO WHOM. Switching on lists the trainer's NAME and online record on third-party public MQTT brokers (the ones lib/netplay.js already pairs through), where anyone
// using Play online sees it. Nothing else leaves the browser: no team, no profile. Switching off, or closing the page, takes the listing down. The FIRST time a player switches it on, a
// small dialog says so and asks (OK / Cancel; remembered in localStorage 'arena.open.seen'); the same-browser transport (?net=local, the tests') publishes nothing anywhere and skips it
// unless ?opendisc=1 asks for it.
//
// THE TWO DIALOGS ARE ONE HELPER (mountDialog). Its default button is the safe one (NOT NOW / Cancel) and it carries data-nav-close, which is how the input layer dismisses a dialog (the music list of the audio bar is the one dialog without one, it closes itself on Escape) by
// B / Escape / X / Backspace (uinav.js clicks it; a dialog without one gets a synthetic Escape keydown from uinav instead, and that leaves the input layer's B held for good). The
// challenge's Accept is inert (disabled) for its first 600 ms, and an Accept the focus only DRIFTED onto (a key or stick that was already held when the dialog appeared repeating towards
// it) ignores the keyboard and the pad until a fresh press says it was meant: a stray A press must not carry a player off to another page. Drift is read from the input events (a REPEAT that left the
// focus on Accept, a fresh press clears it), never from who moved the focus first: with the challenge stacked over the Controls dialog or the Sound panel, THEIR navigation moves the focus
// before this module hears the press. The page keeps its OWN pause state per owner
// (a Set of who holds it: the Controls dialog, the Sound panel, this module's dialogs), so closing one dialog never un-pauses the page behind another that is still open.

import { createOpenLobbies, createLocalBus, createMqttBus, brokersFor } from './openlobby.js';
import { createPresence, isOpen, setOpen, acceptHref, TIMING } from './presence.js';
import { PINNED } from './rom.js';
import { DEFAULT_RULESET_ID } from './rules.js';

export const SEEN_KEY = 'arena.open.seen';        // '1' once the player has read what the switch publishes and said OK
export const FORMAT = '3v3';                      // every resident is listed, and every accepted challenge is played, as 3 v 3 (there is no format preference to read)
export const ACCEPT_INERT_MS = 600;
const STYLE_ID = 'arena-challenge-style';
const CSS = `
.arena-chal { position: fixed; inset: 0; z-index: 3100; background: rgba(0, 0, 0, .72); display: flex; align-items: center; justify-content: center; padding: 12px; }
.arena-chal[hidden] { display: none !important; }
.arena-chal .dlg { width: min(100%, 380px); background: var(--panel, #1a1a1f); color: var(--fg, #ddd); border: 1px solid var(--accent, #6af); border-radius: 10px; padding: 16px; font: 15px/1.45 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0, 0, 0, .6); }
.arena-chal h2 { margin: 0 0 8px; font-size: 18px; }
.arena-chal p { margin: 0 0 8px; }
.arena-chal .dim { color: var(--dim, #99a); font-size: 13px; }
.arena-chal .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.arena-chal button { font: inherit; color: var(--fg, #ddd); background: var(--btn, #222); border: 1px solid var(--line, #3a3a44); border-radius: 6px; min-height: 44px; min-width: 44px; padding: 8px 16px; cursor: pointer; }
.arena-chal button:hover { background: var(--btn-hi, #333); }
.arena-chal button.ok { background: #27466f; border-color: var(--accent, #6af); }
.arena-chal button:disabled { opacity: .45; cursor: default; }
.arena-chal button:focus-visible { outline: 2px solid var(--accent, #6af); outline-offset: 2px; }
`;
const CHALLENGE_IDS = { root: 'challenge', title: 'chTitle', text: 'chText', sub: 'chSub', ok: 'chAccept', cancel: 'chDecline', flag: 'challenge' };
const DISCLOSURE_IDS = { root: 'openInfo', title: 'oiTitle', text: 'oiText', sub: 'oiSub', ok: 'oiOk', cancel: 'oiCancel', flag: 'openinfo' };
const DISCLOSURE_TEXT = 'Turning this on lists your trainer name and your online record (wins and losses) on public servers, where anyone using Play online can see them and challenge you.';
const DISCLOSURE_SUB = 'Nothing else is shared: no team and no profile. Closing this page, or switching Open off, takes the listing down. It only works while the hub or a battle against the computer is open.';
const DIRS = new Set(['up', 'down', 'left', 'right']);
// What the switch says. ONE accessible name whatever the state (aria-pressed says on / off; a name that changed as well -- "Open: on" -- was read out twice); the tooltip says what is published
// (the trainer name AND the online record), and index.html / battle.html carry the same off-state text, which is what the button shows until this module has mounted.
export const OPEN_LABEL = 'Open to battles';
export const OFF_TITLE = 'Open to battles: list your trainer name and online record on public servers so anyone using Play online can challenge you while you are in the hub or in a battle against the computer. The first time you switch it on, it asks you to confirm.';
const ON_TITLE = 'You are open to battles: your trainer name and online record are listed on public servers for anyone using Play online. Press to take the listing down.';
const OFFLINE_TITLE = 'Open to battles is on, but no public server can be reached right now, so nobody can see your listing. Press to take it down.';
const ON_SAYS = 'Open to battles. Your trainer name and online record are listed for anyone using Play online.';

/**
 * The one small modal this module draws. opts: { doc, win, input, enableDomNav, ids, heading, okLabel, cancelLabel, inertMs, onOpen, onClose, onOk, onCancel }
 *   cancel (data-nav-default AND data-nav-close) is the safe button and what B / Escape press; ok is inert (disabled) for the first inertMs.
 *   The owner of onOk / onCancel normally closes the dialog; if it does not, it is closed here.
 * -> { show({ text, sub }), hide(), isOpen(), destroy(), el }
 */
export function mountDialog(opts) {
  const { doc, win, ids } = opts;
  const inertMs = Math.max(0, opts.inertMs | 0);
  let el = null, nav = null, open = false, destroyed = false, opener = null, timer = 0, offAction = null, shownAt = 0, inert = false, viaRepeat = false, wasOnOk = false;
  let text = null, sub = null, ok = null, cancel = null;
  const nowMs = () => (win.performance && win.performance.now ? win.performance.now() : Date.now());
  const answer = (name) => { if (typeof opts[name] === 'function') opts[name](); if (open) hide(); };
  // an input layer that failed to start cannot deliver B: Escape still declines
  const onKey = (e) => { if (open && e.key === 'Escape' && !nav) answer('onCancel'); };
  function build() {
    if (el || destroyed) return;
    if (!doc.getElementById(STYLE_ID)) { const st = doc.createElement('style'); st.id = STYLE_ID; st.textContent = CSS; (doc.head || doc.documentElement).appendChild(st); }
    const stale = doc.getElementById(ids.root);                    // one dialog per page: a second mount (a reloaded module, a test) never leaves a duplicate id behind
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    el = doc.createElement('div');
    el.id = ids.root; el.className = 'arena-chal'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', ids.title); el.setAttribute('aria-describedby', ids.text); el.hidden = true;
    el.innerHTML = '<div class="dlg"><h2 id="' + ids.title + '"></h2><p id="' + ids.text + '"></p><p id="' + ids.sub + '" class="dim"></p><div class="row"><button id="' + ids.cancel + '" type="button" data-nav-default data-nav-close></button><button id="' + ids.ok + '" type="button" class="ok"></button></div></div>';
    el.querySelector('h2').textContent = opts.heading;
    text = el.querySelector('#' + ids.text); sub = el.querySelector('#' + ids.sub); ok = el.querySelector('#' + ids.ok); cancel = el.querySelector('#' + ids.cancel);
    cancel.textContent = opts.cancelLabel; ok.textContent = opts.okLabel;
    (doc.body || doc.documentElement).appendChild(el);
    ok.addEventListener('click', (e) => {
      if (inert || ok.disabled || nowMs() - shownAt < inertMs) return;
      if (viaRepeat && e.detail === 0) return;                      // the focus only drifted here (a held key repeating): a keyboard or pad activation is not yet a decision
      answer('onOk');
    });
    ok.addEventListener('blur', () => { viaRepeat = false; wasOnOk = false; });
    cancel.addEventListener('click', () => answer('onCancel'));
    doc.addEventListener('keydown', onKey);
  }
  // WHO MOVES THE FOCUS FIRST IS NOT KNOWN HERE. This dialog's own navigation (made in show) hears a press after this listener, but a dialog still open UNDER this one (the Controls dialog, the Sound
  // panel) subscribed to the input layer earlier and, scoped to the topmost modal, has already moved the focus by the time this runs: sampling the focus now saw "already on Accept" and never
  // armed the guard (hold Right, a challenge arrives over Controls, Z accepted). So nothing is read off the focus at the moment of the press. Once a microtask has run, every navigation has finished
  // with THIS press, and the press itself decides (`wasOnOk` = where the focus was when the previous press was settled):
  //   a fresh press (repeat false) is a decision, whatever it moved;   a REPEAT that left the focus on Accept when it was not there before is a drift: the keyboard and the pad are ignored until a fresh press.
  function watchFocus(ev) {
    if (!ev.pressed || !DIRS.has(ev.action)) return;
    Promise.resolve().then(() => {
      const there = open && doc.activeElement === ok, arrived = there && !wasOnOk;
      wasOnOk = there;
      if (!open) return;
      if (!ev.repeat) viaRepeat = false;
      else if (arrived) viaRepeat = true;
    });
  }
  function show(p) {
    if (destroyed) return false;
    build();
    text.textContent = p.text; sub.textContent = p.sub || '';
    if (open) return true;
    opener = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;      // what had the focus gets it back (a dialog opened over another dialog returns into that one)
    const body = doc.body || doc.documentElement;
    if (el.parentNode !== body || el.nextElementSibling) body.appendChild(el);                   // LAST in the document: uinav.js picks its modal by document order, so the nav, the focus trap and the paint order agree
    inert = inertMs > 0; ok.disabled = inert; viaRepeat = false; wasOnOk = false;
    el.hidden = false; open = true; shownAt = nowMs(); doc.body.dataset[ids.flag] = 'open';
    if (inert) timer = win.setTimeout(() => { timer = 0; inert = false; ok.disabled = false; }, inertMs);
    if (opts.input && typeof opts.input.on === 'function') offAction = opts.input.on('action', watchFocus);
    if (typeof opts.enableDomNav === 'function' && opts.input) { try { nav = opts.enableDomNav(el, { input: opts.input, onBack: () => answer('onCancel') }); nav.focusFirst(); } catch (_e) { nav = null; } }
    if (!nav) { try { cancel.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    if (typeof opts.onOpen === 'function') opts.onOpen();
    return true;
  }
  function hide() {
    if (!open) return;
    open = false;
    if (timer) { win.clearTimeout(timer); timer = 0; }
    if (offAction) { offAction(); offAction = null; }
    try { if (nav && nav.disable) nav.disable(); } catch (_e) { /* ignore */ }
    nav = null; el.hidden = true; delete doc.body.dataset[ids.flag];
    const back = opener; opener = null;
    if (back && back.isConnected) { try { back.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    if (typeof opts.onClose === 'function') opts.onClose();
  }
  function destroy() {
    if (destroyed) return;
    if (open) hide();
    destroyed = true;
    doc.removeEventListener('keydown', onKey);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
  }
  return { show, hide, isOpen: () => open, destroy, get el() { return el; } };
}

/** The challenge dialog. opts: { doc, win, input, enableDomNav, onOpen, onClose, onAccept(), onDecline() } -> { show({ name, rec, fmtText }), hide(), isOpen(), destroy(), el } */
export function mountChallengeDialog(opts) {
  const d = mountDialog({ ...opts, ids: CHALLENGE_IDS, heading: 'Battle challenge', okLabel: 'Accept', cancelLabel: 'Not now', inertMs: ACCEPT_INERT_MS, onOk: opts.onAccept, onCancel: opts.onDecline });
  return {
    show: (p) => d.show({ text: p.name + (p.rec ? ' (' + p.rec[0] + '-' + p.rec[1] + ' online)' : '') + ' wants to battle you.', sub: 'Accepting opens a battle with them and leaves this page' + (p.fmtText ? ' (' + p.fmtText + ').' : '.') }),
    hide: d.hide, isOpen: d.isOpen, destroy: d.destroy, get el() { return d.el; },
  };
}

/**
 * The active profile's trainer name and online record [wins, losses]. Never throws. A read that FAILED must not look like a read that found nobody (the listing would flip to "Player" with no record):
 *   { ok: true, trainer: { name, rec } }   the store answered and there is a profile
 *   { ok: true, trainer: null }            the store answered and there is none (no active profile, or one that cannot be read)
 *   { ok: false }                          the store could not be read: something threw, or openStore() fell back to its EMPTY in-memory copy (it never throws for a storage problem). That says
 *                                          nothing about the player, so a caller keeps what it had
 */
export async function readTrainer() {
  let store = null;
  try {
    const { openStore } = await import('./store.js');
    store = await openStore();
    const st = store.status;
    if (st.fellBack || st.mode === 'memory') return { ok: false };
    const pid = await store.getActiveId();
    const loaded = pid ? await store.loadProfile(pid) : null;
    if (!loaded || !loaded.ok) return { ok: true, trainer: null };
    const on = loaded.profile.stats && loaded.profile.stats.byCpu && loaded.profile.stats.byCpu.online;
    const rec = on && Number.isInteger(on.w) && Number.isInteger(on.l) ? [Math.min(on.w, 999999), Math.min(on.l + (Number.isInteger(on.f) ? on.f : 0), 999999)] : null;
    return { ok: true, trainer: { name: loaded.profile.trainerName, rec: rec && (rec[0] || rec[1]) ? rec : null } };
  } catch (_e) { return { ok: false }; } finally { if (store) { try { await store.close(); } catch (_e2) { /* ignore */ } } }
}
const trainerKey = (t) => JSON.stringify(t ? [t.name, t.rec] : null);

/**
 * opts: { win, doc, pack, input, enableDomNav, navigate, button (the switch, or null), buttonText (false: the button draws its own face, an icon -- only its state, name and tooltip are kept current),
 *         focusHome() (where the focus goes after a mouse click on the switch),
 *         onDialog: { open(which), close(which) } (a page pauses what it is doing while one of our dialogs is up; `which` names it, so a page can tell its dialogs apart) }
 * -> { setOn(on), isOn(), refresh(), dispose() }
 */
export function mountPresence(opts) {
  const { win, doc } = opts;
  if (win.__arenaPresence && typeof win.__arenaPresence.dispose === 'function') { try { win.__arenaPresence.dispose(); } catch (_e) { /* ignore */ } }      // one per page
  let storage = null; try { storage = win.localStorage; } catch (_e) { storage = null; }
  let session = null; try { session = win.sessionStorage; } catch (_e) { session = null; }
  const q = new URLSearchParams(win.location.search);
  const local = q.get('net') === 'local';
  const timing = { ...TIMING };
  if (local) {                                    // test seams, only for the same-browser transport (like arenaturn / arenagrace)
    const c = Number(q.get('openchal')); if (Number.isInteger(c) && c >= 300 && c <= 120000) { timing.answerMs = c; timing.connectMs = c * 2; }
  }
  const button = opts.button || null;
  const showText = opts.buttonText !== false;
  const nowMs = () => (win.performance && win.performance.now ? win.performance.now() : Date.now());
  let lobbies = null, presence = null, on = false, starting = null, disposed = false, trainer = null, gen = 0, refreshing = null, again = false;
  const offs = [];
  const listen = (t, type, fn) => { t.addEventListener(type, fn); offs.push(() => t.removeEventListener(type, fn)); };

  const seen = () => { try { return !!storage && storage.getItem(SEEN_KEY) === '1'; } catch (_e) { return false; } };
  const markSeen = () => { try { if (storage) storage.setItem(SEEN_KEY, '1'); } catch (_e) { /* the next switch-on asks again */ } };
  const disclosureWanted = () => (!local || q.get('opendisc') === '1') && !seen();      // the same-browser transport publishes nothing anywhere: nothing to disclose
  const pageDialog = (which, v) => { const f = opts.onDialog && opts.onDialog[v ? 'open' : 'close']; if (typeof f === 'function') f(which); };

  function paint() {
    if (!button) return;
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', OPEN_LABEL);
    // "on" while the brokers cannot be reached would be a lie: nobody can see the listing, so say so (the name is constant, so a screen reader gets it from the tooltip, its description)
    const offline = on && lobbies && lobbies.status() === 'down';
    if (showText) button.textContent = 'Open: ' + (on ? (offline ? 'on, offline' : 'on') : 'off');
    button.title = !on ? OFF_TITLE : offline ? OFFLINE_TITLE : ON_TITLE;
  }
  function say(t) { const live = doc.getElementById('live'); if (live) live.textContent = t; }

  // ONE challenge dialog and ONE disclosure per page, however often the switch goes on and off (each used to be built again at every switch-on, leaving duplicate ids)
  const dialog = mountChallengeDialog({
    doc, win, input: opts.input, enableDomNav: opts.enableDomNav,
    onOpen: () => pageDialog('challenge', true), onClose: () => pageDialog('challenge', false),
    onAccept: () => { if (presence) presence.accept(); }, onDecline: () => { if (presence) presence.decline(); },
  });
  const disclosure = mountDialog({
    doc, win, input: opts.input, enableDomNav: opts.enableDomNav, ids: DISCLOSURE_IDS, heading: 'Open to battles', okLabel: 'OK', cancelLabel: 'Cancel', inertMs: 0,
    onOpen: () => pageDialog('disclosure', true), onClose: () => pageDialog('disclosure', false),
    onOk: () => { markSeen(); setOn(true); },
  });

  async function begin(mine) {
    const [t, om] = await Promise.all([readTrainer(), import('./online_match.js')]);
    if (disposed || mine !== gen) return false;                       // switched off (or off and on again) while this was loading: build nothing, so there is nothing to take down
    trainer = t.ok ? t.trainer : null;                                // a store that could not be read lists the player as "Player" for now; the next read that works (refresh) says who they are
    const fp = om.engineFingerprint(opts.pack);
    const bus = local ? createLocalBus(win) : createMqttBus(win, { brokers: brokersFor(win) });
    lobbies = createOpenLobbies({ bus, now: nowMs, mine: { rom: PINNED.sha256, fp } });
    const identity = () => ({ name: (trainer && trainer.name) || 'Player', rec: trainer ? trainer.rec : null, fmt: FORMAT, rom: PINNED.sha256, fp, rs: DEFAULT_RULESET_ID });
    lobbies.watch(paint);                  // a broker coming up, or none being reachable, changes what the switch says
    presence = createPresence({
      lobbies, identity, timing, now: nowMs, session,
      ui: { show: (p) => dialog.show({ ...p, fmtText: '3 v 3' }), hide: () => dialog.hide() },
      navigate: opts.navigate || ((u) => win.location.assign(u)),
      hrefFor: (p, id) => acceptHref({ s: p.s, r: p.r, fmt: id.fmt, extra: local ? '&net=local' + (timing.answerMs !== TIMING.answerMs ? '&openchal=' + timing.answerMs : '') : '' }),
    });
    presence.start();
    return true;
  }
  async function setOn(v, { persist = true } = {}) {
    v = !!v;
    if (disposed) return false;
    if (persist) setOpen(storage, v);
    if (v) {
      if (on) { paint(); if (starting) await starting; return on; }
      on = true; paint();
      const mine = ++gen;
      const p = begin(mine).catch((e) => { if (win.console) win.console.warn('[presence]', e); return false; });
      starting = p;
      const started = await p;
      if (starting === p) starting = null;
      if (mine !== gen) return on;                                    // a later switch took over while this was starting; it says what happened
      if (!started && !disposed) { teardown(); on = false; paint(); say('Open to battles could not start.'); return false; }
      if (disposed) return false;
      say(ON_SAYS);
      return true;
    }
    ++gen; on = false; paint(); teardown();                           // a begin() still loading sees the new generation and builds nothing
    say('No longer open to battles.');
    return false;
  }
  function teardown() {
    const p = presence, l = lobbies;
    presence = null; lobbies = null;
    try { if (p) p.stop(); } catch (_e) { /* ignore */ }
    try { if (l) l.close(); } catch (_e) { /* ignore */ }
  }
  // the listing says what the profile says NOW: a rename, another profile, a new online record, a record that was reset (read again when the tab comes back, after a back/forward-cache restore, and
  // when the hub empties the record). A read that FAILED says nothing and changes nothing; only a read that worked and differs is listed again. A call that comes while a read is under way may be
  // about something that read already missed (the record was reset after it began), so it makes the read run once more instead of being handed the old answer.
  function refresh() {
    if (refreshing) { again = true; return refreshing; }
    if (!presence) return Promise.resolve(false);
    const p = (async () => {
      let changed = false;
      try {
        for (;;) {
          again = false;
          const r = await readTrainer();
          if (disposed || !presence) break;
          if (r.ok && trainerKey(r.trainer) !== trainerKey(trainer)) { trainer = r.trainer; presence.refresh(); changed = true; }
          if (!again) break;
        }
      } finally { refreshing = null; }                                // in the same turn as the last look at `again`: a call after this starts a read of its own
      return changed;
    })();
    refreshing = p;
    return p;
  }
  const api = {
    setOn, isOn: () => on, refresh,
    get presence() { return presence; }, get lobbies() { return lobbies; },
    dispose() {
      if (disposed) return;
      disposed = true; ++gen; on = false;
      for (const o of offs.splice(0)) { try { o(); } catch (_e) { /* ignore */ } }
      teardown();
      dialog.destroy(); disclosure.destroy();
      if (button) delete button.dataset.presence;
      if (win.__arenaPresence === api) delete win.__arenaPresence;
    },
  };

  function onClick(e) {
    // a mouse or a finger leaves nothing focused: a button left focused would be toggled again by the next Enter or Space (the other header buttons hand the focus back the same way)
    if (e && e.detail > 0) { try { button.blur(); } catch (_e) { /* ignore */ } if (typeof opts.focusHome === 'function') { try { opts.focusHome(); } catch (_e) { /* ignore */ } } }
    if (!on && disclosureWanted()) { disclosure.show({ text: DISCLOSURE_TEXT, sub: DISCLOSURE_SUB }); return; }
    setOn(!on);
  }
  // the switch is one setting of this BROWSER: another tab turning it off (or on) is followed here, so a CPU battle opened earlier stops listing and stops showing dialogs when it goes off
  function onStorage(e) {
    if (disposed) return;
    if (e.storageArea && storage && e.storageArea !== storage) return;
    if (e.key !== null && e.key !== 'arena.open') return;
    const want = isOpen(storage) && !disclosureWanted();
    if (want !== on) setOn(want, { persist: false });
  }
  if (button) listen(button, 'click', onClick);
  listen(win, 'storage', onStorage);
  // leaving the page takes the listing down at once and lets go of the brokers; coming back from the back/forward cache lists again (a new load starts from the stored switch)
  listen(win, 'pagehide', () => { ++gen; if (on || presence) { on = false; teardown(); } });
  listen(win, 'pageshow', (e) => {
    if (!e.persisted) return;
    if (isOpen(storage) && !disclosureWanted() && !on) setOn(true, { persist: false });          // begin() reads the trainer again
    else { paint(); if (on) refresh(); }
  });
  listen(doc, 'visibilitychange', () => { if (!doc.hidden) refresh(); });
  if (button) button.dataset.presence = 'ready';        // arena.css keeps the switch invisible (and so unclickable) until it is wired
  win.__arenaPresence = api;
  paint();
  if (isOpen(storage)) { if (disclosureWanted()) setOpen(storage, false); else setOn(true, { persist: false }); }      // a stored "on" nobody was ever told about is not honoured
  return api;
}
