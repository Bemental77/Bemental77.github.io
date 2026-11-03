// pokemonarena/js/editor_import_model.js -- the PURE half of the "Import from a save" screen of the team editor: what the importer's answer
// looks like to a player (the list of Pokemon, their legal / needs-fixing / refused status, what the destination can hold, the plain-language
// message for every way a file can fail). No DOM, no storage, no clock, no randomness: tools/pokemonarena_editor_test.mjs runs it in Node and
// editor_import.js draws it.
//
//   const res = await importSaveFile(file, { rom, pack, deps });                 // saveimport.js
//   const view = buildImportView(res, pack, ruleset);                           // { groups, rejected, summary, ... }
//   const sel = defaultSelection(view, capacity);                               // the legal party members, up to the destination's room
//   const verdict = importVerdict({ selected: sel.size, capacity, hasProfile }); // { ok, reason }
//
// The rows are judged against the DESTINATION's ruleset (a new team uses the profile's default ruleset; an existing team its own): the same
// Pokemon can be legal in one and need fixing in another, so the list is re-judged whenever the destination changes. The importer's own
// verdicts (res.reports[id].validation) are for the ruleset it was given and are not trusted here.

import { validateStoredMon } from './profile.js';
import { rulesetLabel } from './editor_state.js';
import { reasonText } from './editor_data.js';

export const SAVE_FILE_MAX_BYTES = 1048576;        // anything bigger is not a save (a SoulGold flash image is 131,072 bytes); it is not even read
export const TEAM_ROOM = 6;

/** Plain-language text for a failed import. Never echoes file CONTENT; names only sizes and codes. -> { code, title, message, hint } */
export function saveErrorMessage(err, fileSize) {
  const code = err && err.code ? String(err.code) : 'save.internal';
  const n = (v) => Number(v).toLocaleString('en-US');
  const size = err && Number.isInteger(err.size) ? err.size : fileSize;
  switch (code) {
    case 'save.size':
      return { code, title: 'That is not a SoulGold save file', message: `The file is ${n(size)} bytes. A SoulGold save (.sav) is 131,072 bytes (a few tools add 16 bytes or pad it to 139,264).`, hint: 'Pick the battery save that your emulator wrote next to the game (it usually ends in .sav or .srm). Save states are not saves.' };
    case 'save.empty':
      return { code, title: 'This save is empty', message: 'Every byte of the file is blank, so the game was never saved on it.', hint: 'Save inside the game first (START menu, then SAVE), then bring the new file here.' };
    case 'save.no-valid-slot':
      return { code, title: 'This is not a SoulGold v1.1.1 save', message: 'The file has the right size, but neither of its two save slots is a valid SoulGold v1.1.1 save. It may belong to another game or another version of the hack, or it may be damaged.', hint: 'Saves from other Pokemon games, and saves from other versions of this hack, are not read.' };
    case 'save.wrong-rom':
    case 'save.layout':
    case 'save.rom-missing':
      return { code, title: 'This page could not check the save', message: 'The game file this page checks saves against is not Pokemon SoulGold v1.1.1.', hint: 'Reload the page. If it keeps happening, the ROM on this site may have changed.' };
    case 'save.bad-input':
      return { code, title: 'That file could not be read', message: 'The browser did not hand over the file contents.', hint: 'Try choosing the file again.' };
    case 'file.too-large':
      return { code, title: 'That is not a SoulGold save file', message: `The file is ${n(size)} bytes. A SoulGold save is about 131,072 bytes, so this file was not read.`, hint: 'Pick the battery save (.sav) of the game, not a disc image, ROM or save state.' };
    case 'file.empty':
      return { code, title: 'That file is empty', message: 'The file has no bytes in it.', hint: 'Choose the .sav file again.' };
    case 'file.read':
      return { code, title: 'That file could not be read', message: 'The browser could not read the file you chose.', hint: 'Try choosing it again, or copy it somewhere else first.' };
    default:
      return { code, title: 'Something went wrong reading the save', message: 'The save could not be read because of a fault in this page.', hint: 'Nothing was changed. Reload and try again; if it happens again the file is the thing to keep for a bug report.' };
  }
}

// W1 fix D6 (round 3): a reason a player can read. The rules' own meaning for the code, a move that cannot be learnt named in words, and NO machine word left in parentheses
// ("this species cannot know this move (not-learnable)" used to print as it was); the code itself goes into the row's hover text (title), nowhere else.
const MOVE_WHY = { 'not-learnable': 'this Pokemon never learns it', 'level-too-low': 'it is too low a level to know it', 'source-disabled': 'this ruleset does not allow the way it learns it' };
export function plainReason(r, pack) {
  if (r && r.code === 'move.illegal' && r.why) {
    const mv = pack && pack.moves ? pack.moves[r.move] : null;
    return (mv && mv.name ? mv.name : 'One of its moves') + ' cannot be used: ' + (MOVE_WHY[r.why] || 'the rules do not allow it') + '.';
  }
  return String(reasonText(r && r.code, r && r.message) || '').trim() || 'the rules do not allow this';          // (reasonText also drops a machine word in parentheses from a message that is not a known code)
}

const nature = (pack, id) => (pack.natures && pack.natures[id] ? pack.natures[id].name : '?');
const speciesOf = (pack, id) => (pack.species[id] || null);

function rowFor(mon, report, pack, ruleset, where) {
  let v;
  try { v = validateStoredMon(mon, pack, ruleset); } catch (_e) { v = { ok: false, reasons: [{ code: 'rules.internal', message: 'the rules could not judge this Pokemon' }] }; }
  const sp = speciesOf(pack, mon.species);
  return {
    id: mon.id, mon, where,
    species: mon.species, speciesName: sp ? sp.name : 'Unknown #' + mon.species,
    name: mon.nickname && mon.nickname !== '' ? mon.nickname : (sp ? sp.name : '?'),
    nickname: mon.nickname || '', level: mon.level, nature: mon.nature, natureName: nature(pack, mon.nature), shiny: !!mon.shiny,
    status: v.ok ? 'legal' : 'fix',
    reasons: v.reasons.map((r) => ({ code: r.code, path: r.path || '', message: plainReason(r, pack) })),
    notes: report && Array.isArray(report.notes) ? report.notes.map((x) => ({ code: x.code, message: x.message })) : [],
    selfCheck: report && report.selfCheck ? { matched: report.selfCheck.matched, total: report.selfCheck.total } : null,
  };
}

/**
 * The importer's answer as a list a player can read: groups [{ id: 'party' | 'box-<n>', title, rows }] (the party first, then every non-empty box),
 * `rejected` (records the importer refused, each with its reason), the trainer, the importer's warnings, and counts judged for `ruleset`.
 */
export function buildImportView(res, pack, ruleset) {
  if (!res || !res.ok) return { ok: false, error: saveErrorMessage(res && res.error) };
  const groups = [];
  const reports = res.reports || {};
  if (res.party.length) groups.push({ id: 'party', title: 'Party', kind: 'party', rows: res.party.map((m, i) => rowFor(m, reports[m.id], pack, ruleset, { party: true, slot: i })) });
  for (const b of res.boxes) {
    if (!b.mons.length) continue;
    const label = b.name && String(b.name).trim() !== '' ? String(b.name).trim() : 'BOX ' + (b.index + 1);
    const plain = label.replace(/\s+/g, '').toLowerCase() === 'box' + (b.index + 1);          // the game's default name ("Box1", "BOX 1"): no need to say it twice
    groups.push({ id: 'box-' + b.index, title: 'Box ' + (b.index + 1) + (plain ? '' : ' (' + label + ')'), kind: 'box', current: !!b.current, rows: b.mons.map((m) => rowFor(m, reports[m.id], pack, ruleset, { box: b.index, slot: reports[m.id] && reports[m.id].where ? reports[m.id].where.slot : 0 })) });
  }
  const rows = groups.flatMap((g) => g.rows);
  const legal = rows.filter((r) => r.status === 'legal').length;
  return {
    ok: true, ruleset, rulesetLabel: rulesetLabel(ruleset), trainer: res.trainer, groups, rows,
    rejected: (res.rejected || []).map((r) => ({ where: r.where, species: r.species, code: r.code, message: plainReason(r, pack), label: whereLabel(r.where) })),
    warnings: (res.warnings || []).map((w) => ({ code: w.code, message: w.message })),
    summary: { total: rows.length, legal, needsFix: rows.length - legal, refused: (res.rejected || []).length, party: res.party.length, boxed: rows.length - res.party.length },
    statCheck: res.summary && res.summary.statCheck ? { matched: res.summary.statCheck.statsMatched, total: res.summary.statCheck.statsTotal } : null,
  };
}

export function whereLabel(w) {
  if (!w) return 'somewhere in the save';
  if (w.party) return 'Party slot ' + (w.slot + 1);
  return 'Box ' + ((w.box | 0) + 1) + ', slot ' + ((w.slot | 0) + 1);
}

/** What the destination can hold. dest = { teamId: null | id, room }; a new team holds TEAM_ROOM. */
export function capacityOf(dest) { return dest && dest.teamId ? Math.max(0, Math.min(TEAM_ROOM, dest.room | 0)) : TEAM_ROOM; }

/** The ids pre-ticked when the list opens: the party's LEGAL members, in order, up to `capacity`. (A player who wants the rest ticks them.) */
export function defaultSelection(view, capacity) {
  const out = new Set();
  if (!view || !view.ok) return out;
  const party = view.groups.find((g) => g.kind === 'party');
  if (!party) return out;
  for (const r of party.rows) { if (out.size >= capacity) break; if (r.status === 'legal') out.add(r.id); }
  return out;
}

/** Select all / none / legal / the party, applied to the whole list (every box, not only the visible ones). */
export function selectionFor(view, mode, capacity) {
  const out = new Set();
  if (!view || !view.ok) return out;
  const take = (rows) => { for (const r of rows) { if (out.size >= capacity) return; out.add(r.id); } };
  if (mode === 'none') return out;
  if (mode === 'all') take(view.rows);
  else if (mode === 'legal') take(view.rows.filter((r) => r.status === 'legal'));
  else if (mode === 'party') { const p = view.groups.find((g) => g.kind === 'party'); if (p) take(p.rows); }
  return out;
}

/** May the Import button act? -> { ok, reason } (reason is shown beside the button when not ok). */
export function importVerdict({ selected, capacity, hasProfile = true }) {
  if (selected < 1) return { ok: false, reason: 'Tick at least one Pokemon.' };
  if (selected > capacity) return { ok: false, reason: capacity === TEAM_ROOM ? `A team holds ${TEAM_ROOM} Pokemon: untick ${selected - capacity}.` : `This team has room for ${capacity} more: untick ${selected - capacity}.` };
  void hasProfile;
  return { ok: true, reason: '' };
}

/** The records for the chosen ids, in LIST order (party first), never in the order they were ticked. */
export function recordsFor(view, selectedIds) {
  return view.rows.filter((r) => selectedIds.has(r.id)).map((r) => r.mon);
}

/** A profile name for a profile made from a save: the save's trainer name when the profile rules accept it, else TRAINER. */
export function profileNameFrom(trainerName, textOk) {
  const n = typeof trainerName === 'string' ? trainerName.trim() : '';
  return n !== '' && (!textOk || textOk(n)) ? n : 'TRAINER';
}
