// pokemonarena/js/editor_import.js -- the "Import from a save" screen of the team editor (route #/import).
//
// A player brings THEIR OWN Pokemon from a Pokemon SoulGold v1.1.1 battery save (.sav) into the Arena. The screen: choose the file (a real file
// input, reachable by mouse, keyboard and touch; a controller can move to it but the browser's file chooser is a window OUTSIDE the page that a pad cannot drive, so
// the screen says so while a pad is the device in use) or drop it anywhere on the editor; the file is read in this browser by saveimport.js
// (nothing is uploaded; the original file is never modified); a list shows every Pokemon with its ROM icon, level, nature and whether it is
// legal, needs fixing (with the reasons) or was refused (with the reason); the player ticks what to bring, chooses a new team or a team with room,
// and Import adds them to the active profile (or to a new profile named after the save's trainer when there is none yet).
//
// Browser module. The decisions (what the list says, what the destination can hold, every failure message) are in editor_import_model.js, which
// Node tests. Text from the save (nicknames, the trainer name) is ALWAYS put in the page with text nodes, never as markup.
//
// app contract (editor_app.js): app.pack, app.rom, app.deps, app.state, app.dispatch(action), app.navigate(route), app.toast(text, kind),
// app.actions.createProfile(name, { stay: true }), app.takePendingSaveFile(), app.registerImport(handle).

import { h, rebuild, iconEl } from './editor_views.js';
import { findTeam, teamMonsOf, rulesetLabel } from './editor_state.js';
import { importSaveFile } from './saveimport.js';
import { textIssue, PROFILE_LIMITS } from './profile.js';
import { DEFAULT_RULESET_ID, resolveRuleset } from './rules.js';
import { buildImportView, saveErrorMessage, defaultSelection, selectionFor, importVerdict, recordsFor, capacityOf, profileNameFrom, SAVE_FILE_MAX_BYTES, TEAM_ROOM } from './editor_import_model.js';

async function sha256Hex(buf) {
  try {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return undefined;
    const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_e) { return undefined; }
}

export function importView(app) {
  const el = h('section', { class: 'screen', 'aria-labelledby': 'h-import', dataset: { import: '1' } });
  const st = { phase: 'idle', file: null, view: null, res: null, error: null, selected: new Set(), dest: 'new', teamName: '', open: new Set(['party']), busy: false, importing: false };
  let token = 0;                                   // a newer file replaces an older read that is still in flight
  // ONE file input for the life of the screen (rebuilding it on every redraw would forget the file name it shows)
  const fileEl = h('input', { type: 'file', 'aria-label': 'Choose a SoulGold save file (.sav)', dataset: { fk: 'save-file', saveFile: '1' } });
  fileEl.addEventListener('change', () => { const f = fileEl.files && fileEl.files[0]; if (f) read(f); });
  // W1 fix A6: a controller cannot open the browser's file chooser (a window outside the page), so while a controller is the device in use the screen says what to do instead
  const padNoteEl = h('p', { class: 'dim', role: 'note', hidden: true, dataset: { padNote: '1' } }, 'A controller cannot open the file chooser: use the mouse, the keyboard or touch to choose the file, or drop it on this page.');
  let padHooked = false, padTries = 0;
  const paintPadNote = () => { try { const i = window.__editor && window.__editor.input; padNoteEl.hidden = !(i && i.sourceKnown && i.lastSource === 'gamepad'); } catch (_e) { padNoteEl.hidden = true; } };
  function hookPadNote() {
    try { const i = window.__editor && window.__editor.input; if (i && !padHooked) { padHooked = true; i.on('source', paintPadNote); } } catch (_e) { /* the note stays hidden */ }
    paintPadNote();
    if (!padHooked && padTries++ < 40 && padNoteEl.isConnected !== false) setTimeout(hookPadNote, 500);          // the page's input layer starts a moment after the screen
  }
  function padNote() { hookPadNote(); return padNoteEl; }

  const profile = () => (app.state ? app.state.profile : null);
  const rulesetNow = () => {
    const p = profile();
    if (st.dest !== 'new' && p) { const t = findTeam(p, st.dest); if (t) return t.ruleset; }
    return p ? p.settings.defaultRuleset : DEFAULT_RULESET_ID;
  };
  function destInfo() {
    const p = profile();
    if (st.dest !== 'new' && p) {
      const t = findTeam(p, st.dest);
      if (t) { let max = TEAM_ROOM; try { max = Math.min(TEAM_ROOM, resolveRuleset(t.ruleset).team.max); } catch (_e) { /* keep 6 */ } return { teamId: t.id, room: Math.max(0, max - t.monIds.length) }; }
    }
    return { teamId: null, room: TEAM_ROOM };
  }
  const capacity = () => capacityOf(destInfo());

  function rejudge() { if (st.res) st.view = buildImportView(st.res, app.pack, rulesetNow()); }

  async function read(file) {
    const mine = ++token;
    st.phase = 'reading'; st.file = { name: String(file && file.name ? file.name : 'save'), size: file ? file.size : 0 }; st.error = null; st.view = null; st.res = null; st.selected = new Set();
    draw();
    const fail = (code, extra) => { if (mine !== token) return; st.error = saveErrorMessage({ code, ...(extra || {}) }, file ? file.size : 0); st.phase = 'error'; draw(); };
    if (!file) return fail('save.bad-input');
    if (file.size === 0) return fail('file.empty');
    if (file.size > SAVE_FILE_MAX_BYTES) return fail('file.too-large', { size: file.size });
    let buf;
    try { buf = new Uint8Array(await file.arrayBuffer()); } catch (_e) { return fail('file.read'); }
    if (mine !== token) return;
    const sha = await sha256Hex(buf);
    if (mine !== token) return;
    const res = await importSaveFile(buf, { rom: app.rom, pack: app.pack, ruleset: rulesetNow(), deps: app.deps, saveSha256: sha });
    if (mine !== token) return;
    if (!res.ok) { st.error = saveErrorMessage(res.error, file.size); st.phase = 'error'; draw(); return; }
    st.res = res; rejudge();
    st.selected = defaultSelection(st.view, capacity());
    st.teamName = '';
    st.phase = 'preview';
    st.open = new Set(['party']);
    draw();
    app.toast(`Read ${st.view.summary.total} Pokemon from the save. Nothing has been added yet.`);
  }

  async function doImport() {
    if (st.importing || st.phase !== 'preview') return;
    const verdict = importVerdict({ selected: st.selected.size, capacity: capacity(), hasProfile: !!profile() });
    if (!verdict.ok) { app.toast(verdict.reason, 'bad'); return; }
    st.importing = true; draw();
    try {
      if (!app.state) {                                           // no profile yet: make one named after the save's trainer, then import into it
        const name = profileNameFrom(st.view.trainer.name, (n) => textIssue(n, PROFILE_LIMITS.trainerName) === null);
        const r = await app.actions.createProfile(name, { stay: true });
        if (!r.ok) { app.toast(r.message || 'Could not make a profile for these Pokemon.', 'bad'); return; }
      }
      const recs = recordsFor(st.view, st.selected);
      const teamId = destInfo().teamId;
      const nm = st.teamName.trim() !== '' ? st.teamName : ((st.view.trainer.name || 'SAVE').slice(0, 9) + ' PARTY');
      const next = app.dispatch({ type: 'saveImport', mons: recs, teamId, name: nm.slice(0, PROFILE_LIMITS.teamName) });
      if (!next || next.error) return;                            // dispatch already told the player why
      const tid = next.result && next.result.teamId;
      app.toast(`Imported ${recs.length} Pokemon ${teamId ? 'into the team' : 'as a new team'}. The save file was not changed.`);
      st.phase = 'idle'; st.res = null; st.view = null; st.selected = new Set(); st.file = null;
      if (tid) app.navigate({ name: 'team', teamId: tid });
    } finally { st.importing = false; if (st.phase === 'preview') draw(); }
  }

  /* ------------------------------------------------------------------------------------------ drawing */
  const badge = (r) => h('span', { class: 'badge ' + (r.status === 'legal' ? 'good' : 'warn'), dataset: { status: r.status } }, r.status === 'legal' ? 'Legal' : `Needs fixing (${r.reasons.length})`);

  function rowEl(r) {
    const cb = h('input', { type: 'checkbox', checked: st.selected.has(r.id), 'aria-label': `Import ${r.speciesName}${r.nickname ? ' called ' + r.nickname : ''}, level ${r.level}`, dataset: { fk: 'imp-' + r.id, pick: r.id } });
    cb.addEventListener('change', () => { if (cb.checked) st.selected.add(r.id); else st.selected.delete(r.id); draw(); });
    const reasons = r.status === 'fix' ? h('ul', { class: 'imp-why' }, r.reasons.slice(0, 3).map((x) => h('li', { title: x.code }, x.message)), r.reasons.length > 3 ? h('li', { class: 'dim' }, `and ${r.reasons.length - 3} more`) : null) : null;
    return h('label', { class: 'imp-row', dataset: { mon: r.id, status: r.status, species: String(r.species) } },
      cb, iconEl(app, r.species, { scale: 2, shiny: r.shiny }),
      h('span', { class: 'meta' },
        h('span', { class: 'name' }, r.name, r.nickname ? h('span', { class: 'dim' }, ' (' + r.speciesName + ')') : null, r.shiny ? h('span', { class: 'dim' }, ' shiny') : null),
        h('span', { class: 'dim' }, `Lv ${r.level} · ${r.natureName} nature`), badge(r), reasons));
  }

  function groupEl(g) {
    const open = st.open.has(g.id);
    const picked = g.rows.filter((r) => st.selected.has(r.id)).length;
    const body = h('div', { class: 'imp-rows stack', hidden: !open, role: 'group', 'aria-label': g.title, dataset: { group: g.id } }, open ? g.rows.map(rowEl) : null);
    const btn = h('button', { type: 'button', class: 'fold-btn', 'aria-expanded': String(open), dataset: { fk: 'grp-' + g.id, group: g.id }, onClick: () => { if (st.open.has(g.id)) st.open.delete(g.id); else st.open.add(g.id); draw(); } },
      `${g.title} · ${g.rows.length} Pokemon${picked ? ' · ' + picked + ' ticked' : ''}`);
    return h('div', { class: 'fold imp-group' }, btn, body);
  }

  function build() {
    const p = profile();
    const kids = [h('h2', { id: 'h-import', tabindex: '-1' }, 'Import from a save')];
    kids.push(h('p', { class: 'dim' }, 'Bring Pokemon from your own Pokemon SoulGold v1.1.1 save file (.sav). The file is read in this browser: nothing is uploaded, and the file itself is never changed.'));
    kids.push(h('div', { class: 'card stack dropzone', dataset: { dropzone: '1' } },
      h('p', null, 'Drop the .sav file anywhere on this page, or choose it here:'), fileEl,
      padNote(),
      st.phase === 'reading' ? h('p', { role: 'status', dataset: { importState: 'reading' } }, `Reading ${st.file.name} (${st.file.size.toLocaleString('en-US')} bytes)...`) : null,
      st.file && st.phase !== 'reading' ? h('p', { class: 'dim', role: 'status', dataset: { importState: st.phase } }, `${st.file.name} · ${st.file.size.toLocaleString('en-US')} bytes`) : null));

    if (st.phase === 'error' && st.error) {
      kids.push(h('div', { class: 'banner bad', role: 'alert', title: st.error.code, dataset: { importError: st.error.code } }, h('strong', null, st.error.title), st.error.message, h('div', { class: 'dim' }, st.error.hint)));
    }

    if (st.phase === 'preview' && st.view) {
      const V = st.view, S = V.summary;
      const tn = V.trainer.name || '?';
      kids.push(h('div', { class: 'card stack', dataset: { importSummary: '1', statCheck: V.statCheck ? V.statCheck.matched + '/' + V.statCheck.total : '' } },
        h('h3', null, `Trainer ${tn}`),
        h('p', null, `${S.total} Pokemon found: ${S.party} in the party, ${S.boxed} in the boxes. ${S.legal} are legal here, ${S.needsFix} need fixing${S.refused ? ', ' + S.refused + ' could not be read' : ''}.`),
        V.warnings.length ? h('ul', { class: 'dim', dataset: { importWarnings: '1' } }, V.warnings.slice(0, 5).map((w) => h('li', null, w.message))) : null));

      // destination
      const teams = p ? p.teams : [];
      const sel = h('select', { 'aria-label': 'Put the Pokemon in', dataset: { fk: 'imp-dest', dest: '1' } },
        h('option', { value: 'new', selected: st.dest === 'new' }, p && p.teams.length >= 16 ? 'A new team (the team limit is reached)' : 'A new team'),
        teams.map((t) => { const room = Math.max(0, TEAM_ROOM - teamMonsOf(p, t.id).length); return h('option', { value: t.id, selected: st.dest === t.id, disabled: room === 0 }, `${t.name} (${teamMonsOf(p, t.id).length} of ${TEAM_ROOM})`); }));
      sel.addEventListener('change', () => { st.dest = sel.value; rejudge(); draw(); });
      const nameIn = h('input', { type: 'text', value: st.teamName, maxlength: String(PROFILE_LIMITS.teamName), placeholder: (tn.slice(0, 9) + ' PARTY'), 'aria-label': 'Name of the new team', autocomplete: 'off', dataset: { fk: 'imp-team-name' } });
      nameIn.addEventListener('input', () => { st.teamName = nameIn.value; });
      kids.push(h('div', { class: 'card stack', dataset: { importDest: '1' } }, h('h3', null, 'Where do they go?'),
        h('label', null, 'Put the ticked Pokemon in', sel),
        st.dest === 'new' ? h('label', null, 'Name of the new team', nameIn) : null,
        h('p', { class: 'dim', dataset: { judged: rulesetNow() } }, `Judged against: ${rulesetLabel(rulesetNow())}. ${p ? '' : 'You have no profile yet: one named ' + profileNameFrom(tn, (n) => textIssue(n, PROFILE_LIMITS.trainerName) === null) + ' will be made.'}`)));

      // selection tools + list
      const cap = capacity();
      const set = (mode) => { st.selected = selectionFor(V, mode, cap); draw(); };
      kids.push(h('div', { class: 'row', role: 'group', 'aria-label': 'Choose which Pokemon to bring' },
        h('button', { type: 'button', class: 'btn', dataset: { act: 'sel-party', fk: 'sel-party' }, onClick: () => set('party') }, 'Tick the party'),
        h('button', { type: 'button', class: 'btn', dataset: { act: 'sel-legal', fk: 'sel-legal' }, onClick: () => set('legal') }, 'Tick all legal'),
        h('button', { type: 'button', class: 'btn', dataset: { act: 'sel-all', fk: 'sel-all' }, onClick: () => set('all') }, 'Tick all'),
        h('button', { type: 'button', class: 'btn', dataset: { act: 'sel-none', fk: 'sel-none' }, onClick: () => set('none') }, 'Tick none'),
        h('span', { class: 'dim', role: 'status', dataset: { picked: String(st.selected.size) } }, `${st.selected.size} ticked, room for ${cap}`)));
      kids.push(...V.groups.map(groupEl));
      if (V.rejected.length) {
        kids.push(h('div', { class: 'card stack', dataset: { importRejected: '1' } }, h('h3', null, `Not imported (${V.rejected.length})`),
          h('ul', { class: 'imp-why' }, V.rejected.slice(0, 30).map((r) => h('li', { title: r.code, dataset: { rejected: r.code } }, `${r.label}: ${r.message}`)), V.rejected.length > 30 ? h('li', { class: 'dim' }, `and ${V.rejected.length - 30} more`) : null)));
      }
      if (!V.rows.length) kids.push(h('div', { class: 'banner info' }, 'This save holds no Pokemon that can be imported.'));

      const verdict = importVerdict({ selected: st.selected.size, capacity: cap, hasProfile: !!p });
      kids.push(h('div', { class: 'row', dataset: { importFooter: '1' } },
        h('button', { type: 'button', class: 'btn primary', disabled: !verdict.ok || st.importing, dataset: { act: 'import-go', fk: 'import-go' }, onClick: doImport }, st.importing ? 'Importing...' : `Import ${st.selected.size} Pokemon`),
        h('button', { type: 'button', class: 'btn', dataset: { act: 'import-cancel', fk: 'import-cancel' }, onClick: () => { token++; st.phase = 'idle'; st.res = null; st.view = null; st.selected = new Set(); st.file = null; draw(); } }, 'Start over'),
        verdict.ok ? null : h('span', { class: 'dim', role: 'status', dataset: { importWhy: '1' } }, verdict.reason)));
    }

    kids.push(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', dataset: { act: 'import-back', fk: 'import-back' }, onClick: () => app.navigate(profile() ? { name: 'teams' } : { name: 'profiles' }) }, 'Back')));
    return kids;
  }

  function draw() { rebuild(el, build); }
  function update() {
    // the profile may have changed under the screen (another tab, undo): keep the destination valid and the list judged by the right rules
    if (st.dest !== 'new') { const p = profile(); if (!p || !findTeam(p, st.dest)) st.dest = 'new'; }
    if (st.phase === 'preview') rejudge();
    draw();
  }

  // D10: a file that arrives by DROP (or from another screen) is put into the file input too, so the chooser names the file the summary below is about
  // (it used to keep showing the previously chosen file's name); if the browser will not let a script fill the input, it is cleared instead
  function mirrorIntoInput(f) {
    try { const dt = new DataTransfer(); dt.items.add(f); fileEl.files = dt.files; }
    catch (_e) { try { fileEl.value = ''; } catch (_e2) { /* ignore */ } }
  }
  const handle = { offerFile: (f) => { if (f) mirrorIntoInput(f); return read(f); }, state: () => ({ phase: st.phase, selected: [...st.selected], dest: st.dest }) };
  if (typeof app.registerImport === 'function') app.registerImport(handle);
  draw();
  const pending = typeof app.takePendingSaveFile === 'function' ? app.takePendingSaveFile() : null;
  if (pending) setTimeout(() => { mirrorIntoInput(pending); read(pending); }, 0);
  return { el, update, offerFile: handle.offerFile };
}
