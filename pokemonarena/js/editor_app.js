// pokemonarena/js/editor_app.js -- page controller for /pokemonarena/editor.html.
//
// Boots the way the arena page does (fetch the SoulGold v1.1.1 ROM the site already serves, verify length + header + SHA-256, decode the data
// tables and the art), then opens the browser-local store and routes between the editor's screens. All state changes go through the pure reducer
// in editor_state.js; this file owns what the reducer must not: storage, files, the clipboard, timers, the router and the save pipeline.
//
// SAVE PIPELINE. Every committed edit schedules an autosave (250 ms later, so one slider drag is one write). Saves are serialised and use the
// store's compare-and-swap; the reducer's `seq` / `savedSeq` counters say whether the document in memory is ahead of the last write, so an edit
// made WHILE a write is in flight is never marked clean. The header shows Saved / Saving / NOT SAVED (sticky when the browser fell back to
// memory) / Changed elsewhere (another tab saved first). Nothing is ever sent to a server.
//
// INPUT. Mouse and touch are plain DOM (every control is a real button / input / select / link, >= 44 px, nothing is hover- or drag-only). The
// keyboard works natively (Tab, Enter, Space, arrows in lists, Escape closes a dialog, Ctrl+Z / Ctrl+Y). A CONTROLLER (and WASD / the arena's
// bindings) is added by the shared input layer: createInput() from input.js turns keyboard / gamepad into twelve actions and enableDomNav() from
// uinav.js moves focus by geometry, activates with A, leaves with B, switches the Build / Moves / Stats tabs with L and R. Both are owned by the
// input stage and loaded here AFTER the page is up and inside a try: if they are missing or broken the editor simply keeps mouse, touch and keyboard.
//
// Test hook: window.__editor = { ready, route(), state(), dispatch(), flush(), store, pack, actions, caps, lastExport, input, nav, ... }.

import { loadVerifiedRom, romUrl, RomLoadError, readable } from './romfetch.js';
import { loadPack } from './tables.js';
import { createArtKit } from './editor_art.js';
import { openStore, ConflictError, ReadOnlyError, ValidationError } from './store.js';
import { initialState, reduce, isDirty, canUndo, canRedo, findTeam, findMon, teamMonsOf } from './editor_state.js';
import { parseRoute, routeHash } from './editor_links.js';
import * as V from './editor_views.js';
import { importView } from './editor_import.js';
import { createControlsDialog } from './controls_dialog.js';
import { describeRomError, showRomError } from './rom_error.js';
import {
  exportBytes, parseExport, planImport, compressionAvailable, defaultDeps, textIssue, PROFILE_LIMITS, EXPORT_MAX_BYTES, IMPORT_CODES, withStoredRecord,
} from './profile.js';
import { encodeTeamCode, decodeTeamCode, teamFromProfile, validateDecodedTeam } from './teamcode.js';
import { identityStatus, ensureIdentity, rotateIdentity } from './identity.js';

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

/** What this browser can do, found by asking (not by reading a property that merely exists). Pure given its scope, so a test can pass a stub. */
export function detectCaps(scope = globalThis) {
  const c = scope.crypto;
  const idb = (() => { try { return !!scope.indexedDB && typeof scope.indexedDB.open === 'function'; } catch (_e) { return false; } })();
  const subtle = !!(c && c.subtle && typeof c.getRandomValues === 'function');
  const reasons = [];
  if (!idb) reasons.push('IndexedDB is unavailable: profiles cannot be saved on this device. The editor still works, in memory only.');
  if (!subtle) reasons.push('WebCrypto is unavailable (it needs https or localhost): identity keys are off.');
  return { indexedDB: idb, webcrypto: subtle, compression: (() => { try { return compressionAvailable('deflate-raw'); } catch (_e) { return false; } })(), reasons };
}

const HINTS = {
  'import.too-large': 'Profile files are small (a few hundred kilobytes). This one is far larger than anything the Export button makes.',
  'import.checksum': 'Export files carry a checksum so damage and hand edits are noticed. If you edited the file on purpose you can import it anyway.',
  'import.rom-mismatch': 'This profile was built for a different game file. The arena only works with Pokemon SoulGold v1.1.1, so it is refused.',
  'import.newer-schema': 'Update this page (reload without the cache) and try again.',
  'import.private-key': 'Export files never contain private keys. A file that does was not made by this page.',
  'import.corrupt': 'The file may have been cut short during download or copying.',
  'import.not-an-export': 'Pick a file made by the Export button (it ends in .pokemonarena.json).',
};

async function main() {
  const $ = (id) => document.getElementById(id);
  const els = { boot: $('boot'), bar: $('bar'), bootText: $('bootText'), err: $('error'), errTitle: $('errTitle'), errMsg: $('errMsg'), errDetail: $('errDetail'), retry: $('retry'), view: $('view'), banners: $('banners'), saveState: $('saveState'), saveText: $('saveText'), toolbar: $('toolbar'), undo: $('undoBtn'), redo: $('redoBtn'), crumbs: $('crumbs'), toast: $('toast'), controls: $('controlsBtn') };
  const caps = detectCaps();
  const T = window.__editor = { ready: false, state: () => null, caps };
  const mbs = (n) => (n / 1048576).toFixed(1);

  const showError = (e) => {
    const kind = e instanceof RomLoadError ? e.kind : 'internal';
    T.error = { kind, message: String(e && e.message ? e.message : e) };
    els.view.hidden = true;
    showRomError({ boot: els.boot, err: els.err, errTitle: els.errTitle, errMsg: els.errMsg, errDetail: els.errDetail, retry: els.retry }, describeRomError(e));          // W1 D7: the one shared error experience (rom_error.js)
    document.body.dataset.state = 'error';
    console.error(e);
    enableErrorNav();
  };
  // W1 fix A2: the error screen is operable by a controller too (d-pad to Try again / Back to the Arena, A to press, B leaves), as on the hub and the battle page. The page's own input
  // layer is only started after a successful load, so the error screen gets a small one of its own, dropped again when Try again succeeds.
  let errNav = null, errInput = null;
  async function enableErrorNav() {
    try {
      if (errNav) { errNav.refresh(); errNav.focusFirst(); return; }
      const [I, N] = await Promise.all([import('./input.js'), import('./uinav.js')]);
      errInput = I.createInput();
      errNav = N.enableDomNav(els.err, { input: errInput, onBack: () => { location.assign('/pokemonarena/'); } });
      errNav.focusFirst();
      T.errorInput = true;
    } catch (_e) { /* mouse, touch and keyboard still work */ }
  }
  function dropErrorNav() {
    try { if (errNav) errNav.disable(); } catch (_e) { /* ignore */ }
    try { if (errInput) errInput.destroy(); } catch (_e) { /* ignore */ }
    errNav = null; errInput = null; T.errorInput = false;
  }

  /* ------------------------------------------------------------------ boot the ROM */
  const loadRom = async () => {
    els.err.hidden = true; els.boot.hidden = false; els.view.hidden = true; els.bar.value = 0; document.body.dataset.state = 'boot';
    els.bootText.textContent = 'Fetching the ROM from this site...';
    try {
      const loaded = await loadVerifiedRom({ onProgress: (got, total) => { els.bar.value = got / total; els.bootText.textContent = 'Loading ROM  ' + mbs(got) + ' / ' + mbs(total) + ' MB'; } });
      els.bar.value = 1; els.bootText.textContent = 'Checking the ROM and decoding its data...';
      await new Promise((r) => setTimeout(r, 0));
      return loaded;
    } catch (e) { showError(e); return null; }
  };
  const rom = await loadRom();
  els.retry.addEventListener('click', async () => { const r = await loadRom(); if (r) { dropErrorNav(); start(r); } });
  if (rom) start(rom);

  async function start({ bytes, sha256 }) {
    let pack, art, store;
    try {
      pack = loadPack(bytes, { verify: 'header', dexText: false });
      art = createArtKit(bytes);
      store = await openStore();
    } catch (e) { showError(e); return; }

    const deps = defaultDeps();
    const ctx = () => ({ pack, deps });
    let S = null;                                  // the editor state of the ACTIVE profile (null = none open)
    let profiles = [];                             // summaries for the profile list
    let view = null, viewKey = null;               // the mounted screen
    let toastTimer = null;
    let saveTimer = null, saving = null, conflict = null, saveError = null, stale = false;
    let route = { name: 'profiles' };

    /* ---------------------------------------------------------------- toasts, banners, indicator */
    const toast = (text, kind = '') => {
      els.toast.textContent = text; els.toast.className = kind; els.toast.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toast.hidden = true; }, kind === 'bad' ? 6000 : 3500);
    };
    const storeStatus = () => store.status;

    function banner(kind, title, text, buttons = []) {
      const b = document.createElement('div');
      b.className = 'banner ' + kind; b.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
      const st = document.createElement('strong'); st.textContent = title; b.appendChild(st); b.appendChild(document.createTextNode(text));
      if (buttons.length) { const row = document.createElement('div'); row.className = 'row'; for (const [label, fn, extra] of buttons) { const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn small ' + (extra || ''); btn.textContent = label; btn.addEventListener('click', fn); row.appendChild(btn); } b.appendChild(row); }
      return b;
    }
    function updateChrome() {
      const st = storeStatus();
      const dirty = S ? isDirty(S) : false;
      let state = 'saved', text = 'Saved';
      if (conflict || stale) { state = 'conflict'; text = 'Changed elsewhere'; }
      else if (st.notSaved || saveError) { state = 'notsaved'; text = 'NOT SAVED'; }
      else if (dirty || saving) { state = 'saving'; text = 'Saving...'; }
      else if (!S) { state = 'saved'; text = 'Ready'; }
      els.saveState.dataset.state = state; els.saveText.textContent = text;
      T.saveState = state;
      const kids = [];
      for (const r of caps.reasons) { if (!caps.indexedDB && /IndexedDB/.test(r) && st.notSaved) continue; kids.push(banner('warn', 'Limited browser. ', r)); } // (the NOT SAVED banner below already says it)
      if (st.notSaved) kids.push(banner('bad', 'NOT SAVED. ', 'This browser is not keeping your profiles (' + (st.reason || 'storage is unavailable') + '). Everything you do lives in memory and is lost when you close the page. Use Export on the Profiles screen to keep a copy.', S ? [['Export a copy now', () => actions.exportProfile(S.profile.id)]] : []));
      if (saveError && !st.notSaved) kids.push(banner('bad', 'The last save failed. ', saveError, [['Try again', () => runSave()]]));
      if (conflict || stale) kids.push(banner('warn', 'This profile was changed in another tab. ', 'Saving here would overwrite that. Choose which version to keep.', [['Use the other tab\'s version', () => actions.reloadActive()], ['Keep my edits here', () => actions.keepMine(), 'danger']]));
      if (S && S.readOnly) kids.push(banner('warn', 'Read-only. ', 'This profile was saved by a newer version of the app. You can look and Export, but not edit.'));
      els.banners.replaceChildren(...kids);
      const inEditor = !!S && route.name !== 'profiles';
      els.toolbar.hidden = !S;
      els.undo.disabled = !S || !canUndo(S) || S.readOnly; els.redo.disabled = !S || !canRedo(S) || S.readOnly;
      els.undo.title = S && canUndo(S) ? 'Undo: ' + S.undo[S.undo.length - 1].label : 'Nothing to undo';
      els.redo.title = S && canRedo(S) ? 'Redo: ' + S.redo[S.redo.length - 1].label : 'Nothing to redo';
      els.undo.setAttribute('aria-label', els.undo.title); els.redo.setAttribute('aria-label', els.redo.title);
      renderCrumbs();
      T.saveState = state;
      return inEditor;
    }
    function renderCrumbs() {
      const parts = [];
      const a = (label, r) => { const el = document.createElement('a'); el.href = routeHash(r); el.textContent = label; return el; };
      const sep = () => { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; s.setAttribute('aria-hidden', 'true'); return s; };
      if (S) {
        parts.push(a('Profiles', { name: 'profiles' }));
        parts.push(sep(), a('Teams', { name: 'teams' }));
        const team = route.teamId ? findTeam(S.profile, route.teamId) : null;
        if (team) { parts.push(sep(), a(team.name, { name: 'team', teamId: team.id })); const mon = route.monId ? findMon(S.profile, route.monId) : null; if (mon) { const s = document.createElement('span'); s.textContent = mon.nickname || V.speciesName({ pack }, mon.species); s.setAttribute('aria-current', 'page'); parts.push(sep(), s); } }
      }
      els.crumbs.replaceChildren(...parts);
    }

    /* ---------------------------------------------------------------- save pipeline */
    function scheduleSave() { if (!S || S.readOnly) return; clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; runSave(); }, 250); }
    async function runSave() {
      if (saving) { try { await saving; } catch (_e) { /* reported below */ } }
      if (!S || S.readOnly || conflict || !isDirty(S)) { updateChrome(); return; }
      const seq0 = S.seq, profile = S.profile;
      saveError = null;
      saving = (async () => {
        try {
          const saved = await store.saveProfile(profile, { reason: 'edit' });
          if (S && S.profile.id === saved.id) S = reduce(S, { type: 'saved', rev: saved.rev, seq: seq0, updatedAt: saved.updatedAt }, ctx());
          noteSummary(saved);
        } catch (e) {
          if (e instanceof ConflictError) conflict = e.detail || {};
          else if (e instanceof ReadOnlyError) saveError = 'This profile is read-only here.';
          else if (e instanceof ValidationError) saveError = 'The profile did not pass its own checks: ' + e.message;
          else saveError = 'Could not write to storage: ' + (e && e.message ? e.message : e);
        }
      })();
      await saving; saving = null;
      updateChrome();
      if (S && isDirty(S) && !conflict && !saveError) scheduleSave();
    }
    async function flush() {
      clearTimeout(saveTimer); saveTimer = null;
      for (let i = 0; i < 6; i++) { await runSave(); if (saving) await saving; if (!S || !isDirty(S) || conflict || saveError) break; }
      updateChrome();
    }
    function noteSummary(p) {
      const i = profiles.findIndex((x) => x.id === p.id);
      const row = { id: p.id, trainerName: p.trainerName, teams: p.teams.length, mons: p.box.length, updatedAt: p.updatedAt, avatar: p.avatar, readOnly: false };
      if (i >= 0) profiles[i] = row; else profiles.push(row);
    }
    async function refreshProfiles() {
      const list = await store.listProfiles();
      const out = [];
      for (const row of list) {
        if (row.id === null || row.corrupt) { if (row.id) out.push({ id: row.id, trainerName: row.trainerName, readOnly: row.readOnly }); continue; }
        if (S && S.profile.id === row.id) { out.push({ id: row.id, trainerName: S.profile.trainerName, teams: S.profile.teams.length, mons: S.profile.box.length, updatedAt: row.updatedAt, avatar: S.profile.avatar, readOnly: false }); continue; }
        const r = await store.loadProfile(row.id);
        out.push(r.ok ? { id: row.id, trainerName: r.profile.trainerName, teams: r.profile.teams.length, mons: r.profile.box.length, updatedAt: r.profile.updatedAt, avatar: r.profile.avatar, readOnly: r.readOnly } : { id: row.id, trainerName: row.trainerName, readOnly: row.readOnly });
      }
      profiles = out;
      app.profiles = out;
    }

    /* ---------------------------------------------------------------- dispatch + render + router */
    function dispatch(action, opts = {}) {
      if (!S) return null;
      const prev = S;
      const next = reduce(S, action, ctx());
      S = next;
      if (next.error && !opts.quiet) toast(next.error.message, 'bad');
      else if (next.notice && !opts.quiet) toast(next.notice.message);
      if (next.seq !== prev.seq) { scheduleSave(); if (action.type === 'rename' || action.type === 'avatar') noteSummary({ ...next.profile }); }
      render();
      return next;
    }
    function navigate(r, { replace = false } = {}) {
      const hash = routeHash(r);
      if (replace) { history.replaceState(null, '', hash); render(); }
      else if (location.hash === hash) render();
      else location.hash = hash;
    }
    function mount(key, make) {
      if (viewKey === key && view) { view.update(); return; }
      V.rebuild(els.view, () => []);
      view = make(); viewKey = key;
      els.view.replaceChildren(view.el);
      const h2 = view.el.querySelector('h2'); if (h2) { try { h2.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
      window.scrollTo(0, 0);
    }
    function render() {
      if (!T.ready && !els.view) return;
      let r = parseRoute(location.hash);
      if (!S && r.name !== 'profiles' && r.name !== 'import') r = { name: 'profiles' };
      if (S && (r.name === 'team' || r.name === 'mon') && !findTeam(S.profile, r.teamId)) r = { name: 'teams' };
      if (S && r.name === 'mon') { const t = findTeam(S.profile, r.teamId); if (!t.monIds.includes(r.monId)) r = { name: 'team', teamId: r.teamId }; }
      route = r;
      const wantHash = routeHash(r);
      if (location.hash !== wantHash && !(r.name === 'profiles' && (location.hash === '' || location.hash === '#'))) history.replaceState(null, '', wantHash);
      document.body.dataset.state = 'ready'; document.body.dataset.route = r.name;
      els.boot.hidden = true; els.err.hidden = true; els.view.hidden = false;
      if (r.name === 'profiles') mount('profiles', () => V.profilesView(app));
      else if (r.name === 'import') mount('import', () => importView(app));
      else if (r.name === 'teams') mount('teams:' + S.profile.id, () => V.teamsView(app));
      else if (r.name === 'team') mount('team:' + r.teamId, () => V.teamView(app, r.teamId));
      else mount('mon:' + r.teamId + ':' + r.monId + ':' + r.tab, () => V.monView(app, r.teamId, r.monId, r.tab));
      // 'Pokemon Arena - <screen>' like every other page of the game
      document.title = 'Pokemon Arena - ' + (r.name === 'profiles' ? 'Team Editor' : r.name === 'teams' ? 'Teams' : r.name === 'team' ? 'Team' : r.name === 'import' ? 'Import Save' : 'Pokemon');
      updateChrome();
    }
    window.addEventListener('hashchange', render);

    /* ---------------------------------------------------------------- actions (everything that touches the store, files, the clipboard) */
    const nameProblem = (name) => {
      if (typeof name !== 'string' || name.trim() === '') return 'Enter a name.';
      const why = textIssue(name, PROFILE_LIMITS.trainerName);
      return why === 'length' ? `At most ${PROFILE_LIMITS.trainerName} characters.` : why === 'chars' ? 'Braces and control characters are not allowed.' : why ? 'That name uses a character the game font cannot draw.' : null;
    };
    async function loadInto(id) {
      const r = await store.loadProfile(id);
      if (!r.ok) return { ok: false, message: r.message || 'That profile could not be read.', code: r.code };
      S = initialState(r.profile, { readOnly: r.readOnly });
      conflict = null; saveError = null; stale = false;
      await store.setActiveId(id).catch(() => {});
      noteSummary(r.profile);
      if (r.quarantined && r.quarantined.length) toast(`${r.quarantined.length} damaged record${r.quarantined.length === 1 ? ' was' : 's were'} set aside while opening this profile.`, 'bad');
      return { ok: true };
    }
    const download = (name, bytes, mime) => {
      T.lastExport = { name, size: bytes.length, mime, head: new TextDecoder().decode(bytes.subarray(0, 80)) };
      try {
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) { toast('Could not start the download: ' + e.message, 'bad'); }
    };
    const actions = {
      async createProfile(name, { stay = false } = {}) {
        const bad = nameProblem(name); if (bad) return { ok: false, message: bad };
        try { await flush(); const saved = await store.createProfile({ trainerName: name }); noteSummary(saved); const r = await loadInto(saved.id); await refreshProfiles(); if (r.ok) { if (!stay) navigate({ name: 'teams' }); toast('Profile created.'); } return r; }
        catch (e) { return { ok: false, message: 'Could not create the profile: ' + (e && e.message ? e.message : e) }; }
      },
      async openProfile(id) {
        if (S && S.profile.id === id) { navigate({ name: 'teams' }); return { ok: true }; }
        await flush();
        const r = await loadInto(id);
        if (!r.ok) { toast(r.message, 'bad'); return r; }
        navigate({ name: 'teams' }); return r;
      },
      async renameProfile(id, name) {
        const bad = nameProblem(name); if (bad) return { ok: false, message: bad };
        if (S && S.profile.id === id) { const r = dispatch({ type: 'rename', name }, { quiet: true }); if (r.error) return { ok: false, message: r.error.message }; await flush(); await refreshProfiles(); render(); return { ok: true }; }
        try { const r = await store.loadProfile(id); if (!r.ok || r.readOnly) return { ok: false, message: 'That profile cannot be renamed here.' }; const next = { ...r.profile, trainerName: name }; await store.saveProfile(next, { reason: 'rename' }); await refreshProfiles(); render(); return { ok: true }; }
        catch (e) { return { ok: false, message: e.message }; }
      },
      async deleteProfile(id) {
        try {
          if (S && S.profile.id === id) { clearTimeout(saveTimer); S = null; viewKey = null; }
          await store.deleteProfile(id); await refreshProfiles();
          if (!S && profiles.length) { /* stay on the list: the player chooses */ }
          navigate({ name: 'profiles' }); render(); toast('Profile deleted.');
        } catch (e) { toast('Could not delete: ' + e.message, 'bad'); }
      },
      async deleteEverything() {
        try { clearTimeout(saveTimer); S = null; viewKey = null; conflict = null; saveError = null; stale = false; const n = await store.deleteEverything(); await refreshProfiles(); navigate({ name: 'profiles' }); render(); toast(`Deleted everything (${n} profile${n === 1 ? '' : 's'}).`); }
        catch (e) { toast('Could not delete: ' + e.message, 'bad'); }
      },
      async exportProfile(id, { gzip = false } = {}) {
        try {
          await flush();
          const r = S && S.profile.id === id ? { ok: true, profile: S.profile } : await store.loadProfile(id);
          if (!r.ok) { toast('That profile could not be read.', 'bad'); return; }
          const out = await exportBytes(r.profile, { gzip: gzip && compressionAvailable('gzip') });
          download(out.name, out.bytes, out.mime);
          toast(`Exported ${out.name} (${(out.bytes.length / 1024).toFixed(1)} KB).`);
        } catch (e) { toast('Export failed: ' + (e && e.message ? e.message : e), 'bad'); }
      },
      async readImportFile(file, opts = {}) {
        const fail = (code, message) => ({ ok: false, code, message, hint: HINTS[code], file });
        if (!file) return fail('import.input', 'No file was chosen.');
        if (file.size > EXPORT_MAX_BYTES) return fail('import.too-large', `The file is ${(file.size / 1048576).toFixed(1)} MB; profile files are limited to ${EXPORT_MAX_BYTES / 1048576} MB. It was not read.`);
        let buf;
        try { buf = new Uint8Array(await file.arrayBuffer()); } catch (e) { return fail('import.input', 'The file could not be read: ' + (e && e.message ? e.message : e)); }
        const r = await parseExport(buf, { pack, ...opts });
        if (!r.ok) return { ...r, hint: HINTS[r.code], message: r.message || IMPORT_CODES[r.code], file };
        return { ...r, file };
      },
      async applyImport(res, mode) {
        try {
          await flush();
          if (mode === 'new') {
            const plan = planImport(null, res.profile, 'new', deps);
            if (!plan.ok) return { ok: false, message: plan.message, code: plan.code };
            const saved = await store.applyImport(plan);
            await refreshProfiles(); const r = await loadInto(saved.id); if (r.ok) { navigate({ name: 'teams' }); toast(`Imported "${saved.trainerName}" as a new profile.`); } return r;
          }
          if (!S) return { ok: false, message: 'Open a profile first.' };
          const cur = await store.loadProfile(S.profile.id);
          if (!cur.ok || cur.readOnly) return { ok: false, message: 'The active profile cannot be changed.' };
          const plan = planImport(cur.profile, res.profile, mode, deps);
          if (!plan.ok) return { ok: false, message: plan.message, code: plan.code };
          const saved = await store.applyImport(plan);
          const r = await loadInto(saved.id); await refreshProfiles(); navigate({ name: 'teams' });
          toast(mode === 'merge' ? `Merged: ${plan.report.addedMons} Pokemon and ${plan.report.addedTeams} team${plan.report.addedTeams === 1 ? '' : 's'} added.` : 'Replaced. A backup of the old version was kept.');
          return r;
        } catch (e) { return { ok: false, message: e instanceof ConflictError ? 'The profile changed in another tab while importing. Nothing was changed; try again.' : 'Import failed: ' + (e && e.message ? e.message : e) }; }
      },
      async decodeCode(text) {
        const r = await decodeTeamCode(text);
        if (!r.ok) return { ok: false, code: r.code, message: r.message };
        const v = validateDecodedTeam(r.team, pack);
        // A card naming a Pokemon this ROM has no entry for cannot be shown or edited: say which one, instead of adding a record nobody can open.
        const missing = r.team.mons.map((m, i) => [i, m.species]).filter(([, sp]) => !pack.species[sp]);
        if (missing.length) return { ok: false, code: 'code.species-unknown', message: 'This code holds ' + (missing.length === 1 ? 'a Pokemon' : missing.length + ' Pokemon') + ' that this ROM does not have (slot ' + missing.map(([i, sp]) => (i + 1) + ': number ' + sp).join(', slot ') + '), so it cannot be opened here.' };
        return { ok: true, team: r.team, validation: { ok: v.ok, count: v.reasons.length } };
      },
      async encodeTeam(teamId) {
        try { const code = await encodeTeamCode(teamFromProfile(S.profile, teamId)); return { ok: true, code }; }
        catch (e) { return { ok: false, message: 'This team cannot be turned into a code yet: ' + (e && e.message ? e.message : e), code: e && e.code }; }
      },
      async copyText(text, box) {
        try { await navigator.clipboard.writeText(text); return true; } catch (_e) { /* fall through to the selection route */ }
        try { if (box) { box.focus(); box.select(); } return document.execCommand('copy'); } catch (_e) { return false; }
      },
      openUrl(url) { location.assign(url); },
      async identityStatus() { if (!S || !caps.webcrypto) return { state: caps.webcrypto ? 'none' : 'unsupported' }; try { return await identityStatus(S.profile, store.keys); } catch (e) { return { state: 'unusable', keyId: null }; } },
      async createIdentity() { try { const r = await ensureIdentity(S.profile, store.keys, deps); if (r.created) { dispatch({ type: 'setIdentity', identity: r.profile.identity }, { quiet: true }); await flush(); toast('Identity key created.'); } } catch (e) { toast('Could not create a key: ' + e.message, 'bad'); } },
      async rotateIdentity() { try { const r = await rotateIdentity(S.profile, store.keys, { acknowledgeLoss: true, reason: 'rotated by player' }); dispatch({ type: 'setIdentity', identity: r.profile.identity }, { quiet: true }); await flush(); toast('Identity key replaced.'); } catch (e) { toast('Could not replace the key: ' + e.message, 'bad'); } },
      async requestPersistence() { const r = await store.requestPersistence(); toast(!r.supported ? 'This browser cannot promise to keep the data.' : r.granted ? 'The browser will keep this data.' : 'The browser declined; export a backup now and then.'); render(); },
      async reloadActive() { conflict = null; stale = false; saveError = null; const id = S.profile.id; await loadInto(id); viewKey = null; render(); toast('Loaded the other tab\'s version.'); },
      async keepMine() { const cur = await store.loadProfile(S.profile.id); if (cur.ok) { S = reduce(S, { type: 'rebase', rev: cur.profile.rev }, ctx()); S = { ...S, profile: withStoredRecord(S.profile, cur.profile) }; conflict = null; stale = false; await flush(); toast('Your version was saved over the other one.'); } render(); },
    };

    /* ---------------------------------------------------------------- the app object the views use */
    // a save file dropped on the page: the import screen takes it (now, or when it opens)
    let importHandle = null, pendingSave = null;
    const app = {
      pack, art, rom: bytes, caps, store, actions, profiles, deps,
      registerImport: (hdl) => { importHandle = hdl; }, takePendingSaveFile: () => { const p = pendingSave; pendingSave = null; return p; },
      get state() { return S; },
      dispatch, navigate, toast, storeStatus, route: () => route, openModal: (spec) => V.openModal(app, spec),
      reducedMotion: () => !!S && (S.profile.settings.reducedMotion || S.profile.settings.animations === 'off'),
    };
    window.__editorApp = app;
    Object.assign(T, { app, state: () => S, dispatch, flush, store, pack, actions, route: () => route, navigate, toast, sha256, caps, saveState: 'saved', profiles: () => profiles, render, conflict: () => conflict });

    /* ---------------------------------------------------------------- toolbar, keyboard, lifecycle */
    els.undo.addEventListener('click', () => dispatch({ type: 'undo' }));
    els.redo.addEventListener('click', () => dispatch({ type: 'redo' }));
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(t.type === 'range' || t.type === 'checkbox' || t.type === 'radio' || t.type === 'number')) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); dispatch({ type: 'undo' }); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); dispatch({ type: 'redo' }); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', () => { flush(); });
    store.on('status', () => updateChrome());
    store.on('external', () => { if (S && store.isStale(S.profile)) { stale = true; updateChrome(); } });

    /* ---------------------------------------------------------------- drag and drop: a .sav dropped anywhere opens the import screen with it */
    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    let dragDepth = 0;
    const setDragging = (on) => { if (on) document.body.dataset.dragging = '1'; else delete document.body.dataset.dragging; };
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; setDragging(true); });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDragging(false); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; setDragging(false);
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (route.name === 'import' && importHandle) importHandle.offerFile(file);
      else { pendingSave = file; navigate({ name: 'import' }); }
    });
    T.dropSave = (file) => { if (route.name === 'import' && importHandle) importHandle.offerFile(file); else { pendingSave = file; navigate({ name: 'import' }); } };

    /* ---------------------------------------------------------------- the Controls panel (the same dialog as the hub and the battle page) */
    let controlsDlg = null;
    if (els.controls) els.controls.addEventListener('click', async () => {
      if (!T.input) { toast('Keyboard and controller settings are still loading. Try again in a moment.', 'bad'); return; }
      if (!controlsDlg) controlsDlg = createControlsDialog({ input: T.input, ownNav: false });
      T.controlsDialog = controlsDlg;
      const ok = await controlsDlg.open();
      if (!ok) toast('The Controls panel could not open.', 'bad');
    });

    /* ---------------------------------------------------------------- sound (MU3): the same SOUND panel as the hub and the battle page, the ROM's music, the cries' level */
    import('./sound_system.js').then((m) => {
      if (T.sound) return;
      T.sound = m.createSoundSystem({ page: 'editor', button: document.getElementById('soundBtn'), input: () => T.input || null, ownNav: false });       // ownNav false: the page's own enableDomNav (below) drives the dialog
      T.sound.setRom({ bytes, pack }); T.sound.menuMusic.set('editor'); window.__arenaSound = T.sound;
    }).catch((e) => { T.soundError = String(e && e.message ? e.message : e); console.warn('[editor] sound is unavailable:', e); });

    /* ---------------------------------------------------------------- controller / keyboard navigation (shared input layer, optional) */
    // B steps out one level: mon -> team -> teams -> profiles -> the arena hub. (An open dialog is closed by the layer first.)
    function goUp() {
      const r = route;
      if (r.name === 'mon') navigate({ name: 'team', teamId: r.teamId });
      else if (r.name === 'team') navigate({ name: 'teams' });
      else if (r.name === 'teams') navigate({ name: 'profiles' });
      else location.assign('/pokemonarena/');
    }
    async function enableInput() {
      try {
        const [I, N] = await Promise.all([import('./input.js'), import('./uinav.js')]);
        const input = I.createInput();
        const nav = N.enableDomNav(document.body, { input, onBack: goUp });
        T.input = input; T.nav = nav; T.inputState = 'on';
        // a controller cannot type: A on a text field opens an on-screen keyboard (osk.js). Optional like the rest of the layer.
        try { const O = await import('./osk.js'); T.osk = O.enableOnScreenKeyboard({ input }); } catch (e) { T.osk = null; console.warn('[editor] the on-screen keyboard is unavailable:', e); }
      } catch (e) { T.inputState = 'off: ' + (e && e.message ? e.message : e); console.warn('[editor] the shared input layer is unavailable; mouse, touch and keyboard still work:', e); }
    }
    T.goUp = goUp;

    /* ---------------------------------------------------------------- open the active profile (if any) and show a screen */
    await refreshProfiles();
    try {
      const activeId = await store.getActiveId();
      const pick = profiles.find((p) => p.id === activeId) || (profiles.length === 1 ? profiles[0] : null);
      if (pick) await loadInto(pick.id);
    } catch (_e) { /* the player picks one */ }
    if (S && (location.hash === '' || location.hash === '#')) history.replaceState(null, '', routeHash({ name: 'teams' }));
    T.ready = true;
    render();
    await refreshProfiles(); app.profiles = profiles; if (view && view.update) view.update();
    enableInput();
  }
}

if (hasDom) {
  main().catch((e) => {
    const err = document.getElementById('error');
    if (err) { err.hidden = false; document.getElementById('boot').hidden = true; document.getElementById('errTitle').textContent = 'Something went wrong'; document.getElementById('errMsg').textContent = String(e && e.message ? e.message : e); }
    if (window.__editor) window.__editor.error = { kind: 'internal', message: String(e && e.message ? e.message : e) };
    console.error(e);
  });
}
