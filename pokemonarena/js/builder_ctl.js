// pokemonarena/js/builder_ctl.js -- THE TEAM BUILDER's side effects: the only file of the app that touches the profile store, storage, timers and the page. boot.js loads it the first time a
// builder screen is entered or an effect with `app: 'builder'` appears (pokemonarena/INAPP.md "The app interface"), so it is also where the heavy pure layers come in (builder_kit.js).
//
// createCtl(env) -> { effect(eff), enter(path), leave(path), dispose() }
//
// WHAT IT DOES: it loads, saves and reloads exactly as the old DOM editor's page controller did (editor_app.js), with the editor state held by the MODEL (builder_hub.js) instead of by a page:
//   ENTER      (the hub's path moved into the builder's screens) make the kit, read the trainer list, load the store's ACTIVE profile (else the only one) into the model, put the focus this tab
//              last had back, and let the model settle (a screen opened by its address without what it shows goes to the nearest one that can be shown)
//   EDIT       the model reduced an edit ({ type: 'edited' }): a 250 ms debounce, then runSave(): store.saveProfile(profile, { reason: 'edit' }) with the store's compare-and-swap, then the
//              reducer's own bookkeeping ({ type: 'saved', rev, seq: the seq the write STARTED from }), so an edit made WHILE a write is in flight is never marked clean; then the hub is told
//              (env.refreshData()), so the main menu's team rows are not stale
//   CONFLICT   another tab saved first (a ConflictError, or the store's own announcement): the question the DOM editor's banner asked, in the picture: USE THE OTHER (load the stored copy) /
//              KEEP MINE (rebase onto the stored rev, carrying the STORED battle and Tower records: profile.js withStoredRecord) / LATER (B: decide later; it is asked again at the next edit).
//              It is a question the player did not ask for, so it is armed (hub_dialog.js DIALOG_ARM_TICKS): a press already on its way cannot answer it
//   READ-ONLY  a profile a newer version saved is never written: the reducer refuses every edit in its own words, and nothing is scheduled
//   LEAVE      (the path moved out of the builder's screens) flush, then DROP the editor state. The hub page also writes profiles outside the reducer (the Tower, RESET RECORD), each
//              bumping the store's rev: a state kept across a leave would save over them, or be refused. Every ENTER loads again
//   FLUSH      on leave, on pagehide, when the tab is hidden, before another profile is opened or made, and on dispose
//   UNDO       Ctrl+Z, and Ctrl+Y or Ctrl+Shift+Z, anywhere in the builder: the model's undo() / redo() (the reducer's stack). Never while a text entry is open (a word being typed), a
//              question is asked, a DOM panel (Controls, Sound) is up, or the key is going to a real text field of the page. The picture has UNDO and REDO rows for everyone else
//   THE CODE   (builder_io.js) the ctl makes a team's ARENA1 code (kit.encodeTeam), says how long it is, COPIES it (navigator.clipboard.writeText) and READS the clipboard on the press of
//              PASTE A CODE (readText); a browser that refuses either is said in the picture. BOTH ARE ASKED IN THE CALL THAT CARRIES THE PRESS (a copy: whenever the code is already made,
//              which it is once the screen has said its length): some browsers allow the clipboard only there. What was pasted or entered is decoded and judged (kit.decodeCode) and
//              handed to the screen
//   THE TEST   the test battle: flush, the codes of the team (and of the other team when one was chosen), then the battle page at editor_links.js battleUrl with a fresh seed
// The trainer list's actions (make, open, rename another, delete a profile) are the store's, so they arrive here as effects. The tab's focus (which team / Pokemon / tab) is kept in
// sessionStorage so a reload comes back to it; the species picker's sort and the STATS tab's EVs / points view are kept in localStorage under the DOM editor's keys.
//
// Test hook: env.hook.builder = { flush(), idle(), state(), kit() }. env.clipboard (tests) stands in for navigator.clipboard.

import { createBuilderKit } from './builder_kit.js';
import { ConflictError, ReadOnlyError, ValidationError } from './store.js';
import { withStoredRecord } from './profile.js';
import { DIALOG_ARM_TICKS, wrapDialog } from './hub_dialog.js';

const ID = 'builder';
export const SAVE_DEBOUNCE_MS = 250;
export const FLUSH_ROUNDS = 6;
export const FOCUS_KEY = 'arena.builder.at';
export const SORT_KEY = 'arena.editor.speciesSort';          // (the DOM editor's key: the remembered sort carries over)
export const VIEW_KEY = 'arena.editor.statsView';            // (the DOM editor's key: 'ev' | 'points')
const PREF_KEYS = Object.freeze({ speciesSort: SORT_KEY, statsView: VIEW_KEY });
/** The longest pasted text that is looked at (a team code is at most 1024 characters; white space is dropped by the decoder). */
export const PASTE_MAX = 8192;
export const CONFLICT_ID = 'builder:conflict', FAILED_ID = 'builder:save-failed', UNSAVED_ID = 'builder:not-kept';
export const CONFLICT_OPTIONS = Object.freeze(['USE THE OTHER', 'KEEP MINE', 'LATER']);
const CONFLICT_TEXT = 'This profile was changed in another tab. Saving here would overwrite that. Choose which version to keep.';
const UNSAVED_TEXT = 'This browser is not keeping your profiles. Everything you make here lives in memory and is lost when you close the page.';
const msgOf = (e) => String(e && e.message ? e.message : e);

export function createCtl(env) {
  const app = env.app, win = env.win || null, doc = env.doc || null;
  const timers = env.timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
  let kit = null, store = null, inside = false, wired = false, warned = false;
  let saveTimer = null, saving = null, conflict = null, saveError = null, stale = false;
  // one thing at a time: an ENTER's load, a profile opened, a LEAVE's flush never overlap (the hub starts a ctl's calls in order but does not wait for them)
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch((e) => { console.warn('[builder] ' + msgOf(e)); }); return p; };
  // ... and what runs BESIDE that queue (a team code being made, copied, read, decoded: none of it touches the store): started at once, so a copy is close to the press that asked for it
  let beside = Promise.resolve();
  const aside = (p) => { beside = Promise.all([beside, Promise.resolve(p).catch(() => {})]).then(() => undefined); return p; };

  const measure = (font, s) => { try { return env.ui && typeof env.ui.measure === 'function' ? env.ui.measure(font, s) : String(s).length * 6; } catch (_e) { return String(s).length * 6; } };
  const pagesOf = (text) => wrapDialog(text, measure, (env.ui && env.ui.R ? env.ui.R.msg.w - 4 : 204) - 12);          // (less the room the dialog's "more" arrow takes)
  const dialog = () => (env.model && env.model.dialog) || null;
  const redraw = () => { try { env.redraw(); } catch (_e) { /* a page that is going */ } };
  const run = (fx) => { if (fx && fx.length) env.run(fx); };
  const tellHub = () => { try { const p = env.refreshData(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_e) { /* the hub reads again at its next refresh */ } };
  const dirty = () => { const S = app.editor(); return !!S && kit.ES.isDirty(S); };

  /** What the model's autosave tag is made from. */
  function sync() {
    const st = store ? store.status : null;
    app.setFlags({ saving: !!saving, conflict: !!conflict || stale, notSaved: !!(st && st.notSaved), failed: !!saveError });
    redraw();
  }

  /* ------------------------------------------------------------------------------------------ per-tab conveniences */
  function readPrefs() {
    const out = {};
    for (const [key, name] of Object.entries(PREF_KEYS)) { try { const v = env.storage ? env.storage.getItem(name) : null; if (typeof v === 'string' && v.length < 16) out[key] = v; } catch (_e) { /* a convenience */ } }
    return out;
  }
  function writePref(key, value) { if (!Object.prototype.hasOwnProperty.call(PREF_KEYS, key)) return; try { if (env.storage) env.storage.setItem(PREF_KEYS[key], String(value)); } catch (_e) { /* a convenience */ } }
  function readFocus() {
    try { const raw = env.session ? env.session.getItem(FOCUS_KEY) : null; if (!raw || raw.length > 400) return null; const j = JSON.parse(raw); return j && typeof j === 'object' && typeof j.profileId === 'string' ? j : null; } catch (_e) { return null; }
  }
  function keepFocus(eff) {
    if (!eff.profileId || !eff.at) return;
    try { if (env.session) env.session.setItem(FOCUS_KEY, JSON.stringify({ profileId: eff.profileId, teamId: eff.at.teamId || null, monId: eff.at.monId || null, tab: eff.at.tab || 'build' })); } catch (_e) { /* a convenience */ }
  }

  /* ------------------------------------------------------------------------------------------ the save pipeline (editor_app.js's, state in the model) */
  function clearTimer() { if (saveTimer !== null) { timers.clear(saveTimer); saveTimer = null; } }
  function scheduleSave() {
    const S = app.editor();
    if (!S || S.readOnly) return;
    clearTimer();
    saveTimer = timers.set(() => { saveTimer = null; runSave(); }, SAVE_DEBOUNCE_MS);
  }
  async function runSave() {
    if (saving) { try { await saving; } catch (_e) { /* reported below */ } }
    const S = app.editor();
    if (!S || S.readOnly || conflict || !kit.ES.isDirty(S)) { sync(); return; }
    const seq0 = S.seq, profile = S.profile;
    let wrote = false;
    saveError = null;
    saving = (async () => {
      try {
        const saved = await store.saveProfile(profile, { reason: 'edit' });
        const now = app.editor();
        if (now && now.profile.id === saved.id) app.apply({ type: 'saved', rev: saved.rev, seq: seq0, updatedAt: saved.updatedAt });
        wrote = true;
      } catch (e) {
        if (e instanceof ConflictError) conflict = e.detail || {};
        else if (e instanceof ReadOnlyError) saveError = 'This profile is read-only here.';
        else if (e instanceof ValidationError) saveError = 'The profile did not pass its own checks: ' + e.message;
        else saveError = 'Could not write to storage: ' + msgOf(e);
      }
    })();
    sync();
    await saving; saving = null;
    sync();
    if (wrote) tellHub();                                             // the main menu's team rows (names, sizes, legal or not) follow the edit
    if (conflict) askConflict();
    else if (saveError) askFailed();
    else if (dirty()) scheduleSave();
  }
  async function flush() {
    clearTimer();
    for (let i = 0; i < FLUSH_ROUNDS; i++) { await runSave(); if (saving) await saving; if (!dirty() || conflict || saveError) break; }
    sync();
  }
  function askConflict() {
    const d = dialog(); if (!d || !inside) return;
    d.open({ id: CONFLICT_ID, app: ID, armTicks: DIALOG_ARM_TICKS, pages: pagesOf(CONFLICT_TEXT), choice: { options: CONFLICT_OPTIONS.slice(), cursor: CONFLICT_OPTIONS.length - 1 } });
    redraw();
  }
  function askFailed() {
    const d = dialog(); if (!d || !inside) return;
    d.open({ id: FAILED_ID, app: ID, armTicks: DIALOG_ARM_TICKS, pages: pagesOf('The last save failed. ' + saveError), choice: { options: ['TRY AGAIN', 'LATER'], cursor: 0 } });
    redraw();
  }
  function closeQuestions() { const d = dialog(); if (d) { d.close(CONFLICT_ID); d.close(FAILED_ID); } }

  /* ------------------------------------------------------------------------------------------ profiles */
  async function loadInto(id) {
    const r = await store.loadProfile(id);
    if (!r.ok) return { ok: false, message: r.message || 'That profile could not be read.' };
    clearTimer(); conflict = null; saveError = null; stale = false; closeQuestions();
    app.setEditor(kit.initialState(r.profile, { readOnly: r.readOnly }));
    try { await store.setActiveId(id); } catch (_e) { /* the list still shows it */ }
    if (r.quarantined && r.quarantined.length) app.note(r.quarantined.length + ' damaged record' + (r.quarantined.length === 1 ? ' was' : 's were') + ' set aside while opening this profile.', true);
    return { ok: true };
  }
  /** The trainer list, as the store has it (the profile being edited is shown by the model as it is NOW). */
  async function refreshTrainers() {
    const out = [];
    for (const row of await store.listProfiles()) {
      if (row.id === null || row.corrupt) { if (row.id) out.push({ id: row.id, name: row.trainerName || '', readOnly: !!row.readOnly, unreadable: true }); continue; }
      let r = null; try { r = await store.loadProfile(row.id); } catch (_e) { r = null; }
      out.push(r && r.ok ? { id: row.id, name: r.profile.trainerName, teams: r.profile.teams.length, mons: r.profile.box.length, avatar: r.profile.avatar, readOnly: !!r.readOnly } : { id: row.id, name: row.trainerName || '', readOnly: !!row.readOnly, unreadable: true });
    }
    app.setTrainers(out);
    return out;
  }
  function nameProblem(name) {
    if (typeof name !== 'string' || name.trim() === '') return 'Enter a name.';
    const max = kit.LIMITS.trainerName, why = kit.textIssue(name, max);
    return why === 'length' ? 'At most ' + max + ' characters.' : why === 'chars' ? 'Braces and control characters are not allowed.' : why ? 'That name uses a character the game font cannot draw.' : null;
  }
  async function createProfile(name) {
    if (!store) return;
    const bad = nameProblem(name);
    if (bad) { app.note(bad, true); redraw(); return; }
    try {
      await flush();
      const saved = await store.createProfile({ trainerName: name });
      const r = await loadInto(saved.id);
      await refreshTrainers();
      if (r.ok) { app.note('Profile created.'); run(app.showTeams()); } else app.note(r.message, true);
    } catch (e) { app.note('Could not create the profile: ' + msgOf(e), true); }
    sync(); tellHub();
  }
  async function openProfile(id) {
    if (!store) return;
    const S = app.editor();
    if (S && S.profile.id === id) { run(app.showTeams()); redraw(); return; }
    await flush();
    const r = await loadInto(id);
    if (!r.ok) app.note(r.message, true); else run(app.showTeams());
    sync(); tellHub();
  }
  async function renameProfile(id, name) {
    if (!store) return;
    const bad = nameProblem(name);
    if (bad) { app.note(bad, true); redraw(); return; }
    try {
      const S = app.editor();
      if (S && S.profile.id === id) { const r = app.edit({ type: 'rename', name }); if (r && r.error) app.note(r.error.message, true); await flush(); }
      else {
        const r = await store.loadProfile(id);
        if (!r.ok || r.readOnly) app.note('That profile cannot be renamed here.', true);
        else await store.saveProfile({ ...r.profile, trainerName: name }, { reason: 'rename' });
      }
      await refreshTrainers();
    } catch (e) { app.note('Could not rename: ' + msgOf(e), true); }
    sync(); tellHub();
  }
  async function deleteProfile(id) {
    if (!store) return;
    try {
      const S = app.editor();
      if (S && S.profile.id === id) { clearTimer(); conflict = null; saveError = null; stale = false; closeQuestions(); app.setEditor(null); }
      await store.deleteProfile(id);
      await refreshTrainers();
      app.note('Profile deleted.');
      run(app.settle());
    } catch (e) { app.note('Could not delete: ' + msgOf(e), true); }
    sync(); tellHub();
  }
  /** "Use the other tab's version": the stored copy replaces what is in memory. */
  async function reloadActive() {
    const S = app.editor(); if (!S || !store) return;
    conflict = null; stale = false; saveError = null;
    const r = await loadInto(S.profile.id);
    if (r.ok) app.note('Loaded the other tab\'s version.'); else app.note(r.message, true);
    run(app.settle());
    sync(); tellHub();
  }
  /** "Keep my edits here": the document in memory is saved over the stored one, WITH the battle record and the Tower record the store holds now. */
  async function keepMine() {
    const S = app.editor(); if (!S || !store) return;
    const cur = await store.loadProfile(S.profile.id);
    if (cur.ok) {
      app.apply({ type: 'rebase', rev: cur.profile.rev });
      app.mapEditor((s) => ({ ...s, profile: withStoredRecord(s.profile, cur.profile) }));
      conflict = null; stale = false;
      await flush();
      if (!conflict && !saveError) app.note('Your version was saved over the other one.');
    }
    sync();
  }

  /* ------------------------------------------------------------------------------------------ the team code and the test battle (builder_io.js) */
  const clip = () => env.clipboard || (win && win.navigator && win.navigator.clipboard) || null;
  const tell = (path, msg) => { run(app.tell(path, msg)); redraw(); };
  // (the code of a team is kept while the profile is the same object: the length is said when the screen opens, and COPY then writes at once, close to the press that asked)
  let made = { profile: null, teamId: null, code: null };
  async function codeOf(teamId) {
    const S = app.editor();
    if (!S) return { ok: false, message: 'No trainer is open.', of: null };
    const profile = S.profile;
    if (made.profile === profile && made.teamId === teamId) return { ok: true, code: made.code, of: profile };
    const r = await kit.encodeTeam(profile, teamId);
    if (r.ok) made = { profile, teamId, code: r.code };
    return { ...r, of: profile };
  }
  async function codeLength(teamId) {
    const r = await codeOf(teamId);
    tell('builder-code', r.ok ? { type: 'length', teamId, chars: r.code.length, of: r.of } : { type: 'length', teamId, error: r.message, of: r.of });
  }
  /** The code already made for this team AS IT IS NOW, or null. */
  const madeFor = (teamId) => { const S = app.editor(); return S && made.profile === S.profile && made.teamId === teamId ? made.code : null; };
  async function codeCopy(teamId) {
    // THE WRITE STARTS IN THE VERY CALL THAT ASKED whenever the code is already made (it is, once the screen has said its length): some browsers let a page copy only from inside the key
    // press or the tap that asked, and refuse a write that starts after an await
    let code = madeFor(teamId);
    if (code === null) { const r = await codeOf(teamId); if (!r.ok) { tell('builder-code', { type: 'copy-refused', message: r.message }); return; } code = r.code; }
    try { const c = clip(); if (!c || typeof c.writeText !== 'function') throw new Error('no clipboard'); await c.writeText(code); }
    catch (_e) { tell('builder-code', { type: 'copy-refused' }); return; }
    tell('builder-code', { type: 'copied', chars: code.length });
  }
  async function codeDecode(text) { tell('builder-code', { type: 'decoded', ...(await kit.decodeCode(String(text).slice(0, PASTE_MAX))) }); }
  async function codePaste() {
    let text = null;
    try { const c = clip(); if (!c || typeof c.readText !== 'function') throw new Error('no clipboard'); text = await c.readText(); }
    catch (_e) { tell('builder-code', { type: 'paste-refused' }); return; }
    if (typeof text !== 'string' || !text.trim()) { tell('builder-code', { type: 'paste-empty' }); return; }
    await codeDecode(text);
  }
  async function testStart(eff) {
    if (!app.editor()) return;
    await flush();
    if (conflict || saveError) return;                                 // (the question about the save is on the screen: the battle waits for its answer)
    const S = app.editor(); if (!S) return;
    const say = (text) => { app.note(text, true); redraw(); };
    const mine = await kit.encodeTeam(S.profile, eff.teamId);
    if (!mine.ok) { say(mine.message); return; }
    let foe = 'random';
    if (eff.foeId) { const f = await kit.encodeTeam(S.profile, eff.foeId); if (!f.ok) { say(f.message); return; } foe = f.code; }
    let url;
    try { url = kit.LINKS.battleUrl({ team: mine.code, foe, seed: env.freshSeed() >>> 0, format: eff.format, cpu: eff.cpu }); } catch (e) { say('The test battle could not be opened: ' + msgOf(e)); return; }
    env.navigate(url);
  }

  /* ------------------------------------------------------------------------------------------ Ctrl+Z / Ctrl+Y */
  function onKey(e) {
    if (!inside || !e || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = String(e.key || '').toLowerCase();
    const type = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo' : null;
    if (!type) return;
    const m = env.model, hk = env.hook, t = e.target;
    if (m && ((typeof m.wantsText === 'function' && m.wantsText()) || (typeof m.textUnder === 'function' && m.textUnder()) || (m.dialog && m.dialog.isOpen()))) return;          // a word being typed, a question
    if (hk && typeof hk.dialogOpen === 'function' && hk.dialogOpen()) return;                                                                                        // a DOM panel (Controls, Sound)
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(String(t.tagName || '')) || t.isContentEditable)) return;                                                            // a real text field keeps its own undo
    if (typeof e.preventDefault === 'function') e.preventDefault();
    run(type === 'undo' ? app.undo() : app.redo());
    redraw();
  }

  /* ------------------------------------------------------------------------------------------ the page's lifecycle */
  function wire() {
    if (wired || !store) return;
    wired = true;
    try {
      store.on('status', () => sync());
      store.on('external', () => { const S = app.editor(); if (inside && S && !stale && store.isStale(S.profile)) { stale = true; sync(); askConflict(); } });
    } catch (_e) { /* a store without events: the compare-and-swap still refuses a stale write */ }
  }
  const onHide = () => { flush(); };
  const onVisibility = () => { if (doc && doc.hidden) flush(); };
  if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', onHide);
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
  if (win && typeof win.addEventListener === 'function') win.addEventListener('keydown', onKey);

  async function begin() {
    inside = true;
    if (!kit) { kit = createBuilderKit({ pack: env.pack, deps: env.deps }); app.attach(kit); app.setPrefs(readPrefs()); }
    app.setPhase('loading'); redraw();
    store = typeof env.whenStore === 'function' ? await env.whenStore() : env.store();
    if (!store) { app.setEditor(null); app.setPhase('nostore'); redraw(); return; }
    wire();
    const list = await refreshTrainers(), ids = list.filter((t) => !t.unreadable).map((t) => t.id);
    let active = null; try { active = await store.getActiveId(); } catch (_e) { active = null; }
    const pick = ids.includes(active) ? active : ids.length === 1 ? ids[0] : null;
    if (pick) { const r = await loadInto(pick); if (!r.ok) app.setEditor(null); } else app.setEditor(null);
    const at = readFocus(), S = app.editor();
    if (at && S && at.profileId === S.profile.id) app.setFocus(at);
    app.setPhase('ready');
    sync();
    run(app.settle());
    redraw();
    if (store.status.notSaved && !warned && dialog()) { warned = true; dialog().open({ id: UNSAVED_ID, app: ID, armTicks: DIALOG_ARM_TICKS, pages: pagesOf(UNSAVED_TEXT), choice: null }); redraw(); }
  }
  async function end() {
    inside = false;
    await flush();
    clearTimer(); closeQuestions();
    conflict = null; stale = false; saveError = null;
    app.setEditor(null);
    if (kit) app.setPhase('loading');
    sync();
  }

  const api = { flush, idle: () => Promise.all([chain, beside]).then(() => undefined), kit: () => kit, state: () => ({ inside, saving: !!saving, conflict: !!conflict, stale, saveError, timer: saveTimer !== null, dirty: kit ? dirty() : false }) };
  if (env.hook && typeof env.hook === 'object') env.hook.builder = api;

  return {
    ...api,
    enter() { return serial(begin); },
    leave() { return serial(end); },
    effect(eff) {
      switch (eff && eff.type) {
        case 'edited': if (conflict || stale) askConflict(); else scheduleSave(); sync(); return undefined;
        case 'opened': keepFocus(eff); return undefined;
        case 'pref': writePref(eff.key, eff.value); return undefined;
        case 'profile-create': return serial(() => createProfile(eff.name));
        case 'profile-open': return serial(() => openProfile(eff.id));
        case 'profile-rename': return serial(() => renameProfile(eff.id, eff.name));
        case 'profile-delete': return serial(() => deleteProfile(eff.id));
        case 'code-length': return aside(codeLength(eff.teamId));
        case 'code-copy': return aside(codeCopy(eff.teamId));
        case 'code-paste': return aside(codePaste());
        case 'code-decode': return aside(codeDecode(eff.text));
        case 'test-start': return serial(() => testStart(eff));
        case 'dialog':
          if (eff.id === CONFLICT_ID && eff.value === 0) return serial(reloadActive);
          if (eff.id === CONFLICT_ID && eff.value === 1) return serial(keepMine);
          if (eff.id === FAILED_ID && eff.value === 0) return runSave();
          return undefined;
        default: return undefined;
      }
    },
    dispose() {
      flush();
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', onHide);
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('keydown', onKey);
    },
  };
}
