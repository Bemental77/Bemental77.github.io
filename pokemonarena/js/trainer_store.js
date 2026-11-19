// pokemonarena/js/trainer_store.js -- THE ONLY WAY the trainer app (trainer_ctl.js) writes a trainer: make one, change one, switch to one, list them (profile schema 6).
//
// A "trainer" is a profile (profile.js): its NAME is `trainerName`, its PORTRAIT is `avatar`, and everything else the new-trainer screens choose is the trainer CARD (`card`,
// trainer_card.js). This module never touches a profile's teams, box, battle record (`stats`), Tower record or identity: it reads the stored profile, changes those three fields
// and writes it back through the store's own compare-and-swap (store.js saveProfile), reading again when another tab saved in between.
//
//   await createTrainer(store, { name, avatar?, card? })      -> { ok: true, id, profile, notSaved } | { ok: false, code, message }
//        a NEW profile, made the ACTIVE one in the same transaction (store.js createActiveProfile). `card` is a patch over the empty card (made: false unless the patch says true).
//   await updateTrainer(store, id, { name?, avatar?, card? })  -> { ok: true, profile, changed, notSaved } | { ok: false, code, message }
//        `card` is a PATCH (trainer_card.js checkCardPatch): only the keys given change; the card's unknown keys (`card._unknown`, a newer build's) are kept. Nothing given or nothing
//        different: { ok: true, changed: false } and nothing is written. An older stored document is upgraded first, the usual way (store.js loadProfile: the old one to history).
//   await setActiveTrainer(store, id)                          -> { ok: true } | { ok: false, code, message }
//   await listTrainers(store)                                  -> [{ id, name, avatar: { kind, id }, card, readOnly, active }]    every readable profile; never throws ([] when storage fails)
//
// THE CODES (`code` of a refusal; the UI turns them into words, TRAINER_CODES has a plain sentence for each):
//   'name'        the name is empty, longer than 10 or uses a character the ROM font cannot draw (profile.js textIssue, PROFILE_LIMITS.trainerName)
//   'avatar'      the portrait is not { kind: 'preset', id: 0..51 } (the ROM's 52 trainer heads, editor_state.js AVATAR_PRESETS) or { kind: 'mon', id: 1..65535 }
//   'card'        the card patch is not a trainer_card.js patch (an unknown key, or a bad value); `key` names the key
//   'read-only'   the profile (or the whole database) was saved by a NEWER build: this build may show it but never writes it (reload the page with the newer build)
//   'not-found'   no profile with that id
//   'unreadable'  the stored document cannot be read at all (store.js has put a copy in its quarantine)
//   'not-saved'   the browser refused the write (a full disk, an aborted transaction, or the upgrade of an older document could not be written): nothing changed; store.status.notSaved is now true
//   'conflict'    another tab kept saving this profile while this one tried (TRAINER_RETRIES reads and writes)
//   'store'       anything else (a closed store, a programming error); `detail` says what
// A result that is ok carries `notSaved`: true when this browser is not keeping profiles (memory only): the trainer exists for this visit only, and the UI should say so.
//
// Pure ES module (browser + Node) apart from the injected store: no DOM, no clock, no storage of its own, no randomness (ids come from the store's deps). Never throws.

import { textIssue, PROFILE_LIMITS } from './profile.js';
import { emptyCard, checkCardPatch, cardOf, CARD_KEYS } from './trainer_card.js';
import { AVATAR_PRESETS } from './editor_state.js';
import { avatarOf } from './hub_data.js';

/** How many times updateTrainer reads again after another tab saved first, before it says 'conflict'. */
export const TRAINER_RETRIES = 4;

/** Every refusal code, with a plain sentence the UI may show when it has none of its own. */
export const TRAINER_CODES = Object.freeze({
  name: 'That name cannot be used.',
  avatar: 'That portrait cannot be used.',
  card: 'That choice cannot be saved on the trainer card.',
  'read-only': 'This trainer was saved by a newer version of the app. Reload the page to change it.',
  'not-found': 'That trainer is not in this browser.',
  unreadable: 'That trainer\'s save cannot be read.',
  'not-saved': 'This browser did not keep the change.',
  conflict: 'Another tab kept changing this trainer. Try again.',
  store: 'The trainer could not be saved.',
});

const hasOwn = Object.prototype.hasOwnProperty;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const describe = (e) => (e && (e.name ? e.name + ': ' : '') + (e.message || '')) || String(e);
const fail = (code, message, extra) => ({ ok: false, code, message: message || TRAINER_CODES[code], ...(extra || {}) });
const notSavedOf = (store) => { try { return !!(store && store.status && store.status.notSaved); } catch (_e) { return true; } };

/** null when `name` can be a trainer's name, else a sentence saying why not. */
export function nameIssue(name) {
  if (typeof name !== 'string') return 'A name is text.';
  if (name.trim() === '') return 'A name cannot be empty.';
  const why = textIssue(name, PROFILE_LIMITS.trainerName);
  if (why === 'length') return `A name has at most ${PROFILE_LIMITS.trainerName} letters.`;
  if (why) return 'That name uses a letter the game cannot write.';
  return null;
}

/** null when `a` can be a trainer's portrait, else a sentence saying why not. */
export function avatarIssue(a) {
  if (!isObj(a) || Object.keys(a).some((k) => k !== 'kind' && k !== 'id')) return 'A portrait is { kind, id }.';
  if (a.kind === 'preset') return Number.isInteger(a.id) && a.id >= 0 && a.id < AVATAR_PRESETS ? null : `There are ${AVATAR_PRESETS} portraits (0..${AVATAR_PRESETS - 1}).`;
  if (a.kind === 'mon') return Number.isInteger(a.id) && a.id >= 1 && a.id <= 65535 ? null : 'A Pokemon portrait is a species id 1..65535.';
  return 'A portrait is a trainer (preset) or a Pokemon (mon).';
}

/** A store error -> a refusal. */
function failFrom(e) {
  const c = e && typeof e.code === 'string' ? e.code : '';
  if (c === 'store.conflict') return fail('conflict', null, { detail: describe(e) });
  if (c === 'store.read-only') return fail('read-only', null, { detail: describe(e) });
  if (c === 'store.not-found') return fail('not-found', null, { detail: describe(e) });
  if (c.startsWith('store.') || c.startsWith('profile.') || e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) return fail('store', null, { detail: describe(e) });
  return fail('not-saved', null, { detail: describe(e) });          // the browser refused the write: store.js has flagged notSaved
}

/** The change, checked: { ok: true, change: { name?, avatar?, card? } } | a refusal. */
function checkChange(input, { create }) {
  const o = isObj(input) ? input : {};
  const change = {};
  for (const k of Object.keys(o)) if (k !== 'name' && k !== 'avatar' && k !== 'card') return fail('store', 'a trainer change holds name, avatar and card only, not ' + k, { key: k });
  if (create || o.name !== undefined) { const why = nameIssue(o.name); if (why) return fail('name', why); change.name = o.name; }
  if (o.avatar !== undefined) { const why = avatarIssue(o.avatar); if (why) return fail('avatar', why); change.avatar = { kind: o.avatar.kind, id: o.avatar.id }; }
  if (o.card !== undefined) { const c = checkCardPatch(o.card); if (!c.ok) return fail('card', c.message, { key: c.key }); change.card = c.patch; }
  return { ok: true, change };
}

/** Make a new trainer and make it the active one. */
export async function createTrainer(store, input) {
  const c = checkChange(input, { create: true });
  if (!c.ok) return c;
  const init = { trainerName: c.change.name, card: { ...emptyCard(), ...(c.change.card || {}) } };
  if (c.change.avatar) init.avatar = c.change.avatar;
  try {
    const saved = await store.createActiveProfile(init);
    return { ok: true, id: saved.id, profile: saved, notSaved: notSavedOf(store) };
  } catch (e) { return failFrom(e); }
}

/** `p` with the change applied, or null when it changes nothing. Never touches anything but trainerName, avatar and card. */
function applyChange(p, change) {
  const next = { ...p };
  let changed = false;
  if (hasOwn.call(change, 'name') && change.name !== p.trainerName) { next.trainerName = change.name; changed = true; }
  if (change.avatar && !(isObj(p.avatar) && p.avatar.kind === change.avatar.kind && p.avatar.id === change.avatar.id)) {
    next.avatar = { kind: change.avatar.kind, id: change.avatar.id };
    if (isObj(p.avatar) && isObj(p.avatar._unknown)) next.avatar._unknown = p.avatar._unknown;          // a newer build's keys of the portrait stay
    changed = true;
  }
  if (change.card) {
    const cur = cardOf(p);
    if (CARD_KEYS.some((k) => hasOwn.call(change.card, k) && change.card[k] !== cur[k])) {
      next.card = { ...cur, ...change.card };
      if (isObj(p.card) && isObj(p.card._unknown)) next.card._unknown = p.card._unknown;          // ... and of the card
      changed = true;
    }
  }
  return changed ? next : null;
}

/** Change a trainer's name, portrait and / or card (a patch). */
export async function updateTrainer(store, id, input) {
  const c = checkChange(input, { create: false });
  if (!c.ok) return c;
  if (typeof id !== 'string' || !id) return fail('not-found', 'no trainer id was given');
  for (let attempt = 0; attempt < TRAINER_RETRIES; attempt++) {
    let l;
    try { l = await store.loadProfile(id); } catch (e) { return failFrom(e); }
    if (!l || !l.ok) return l && l.code === 'store.not-found' ? fail('not-found') : fail('unreadable', null, { profileCode: l ? l.code : null });
    if (l.readOnly) return fail('read-only');
    if (l.unsaved) return fail('not-saved', null, { detail: 'the upgrade of the stored profile could not be written: ' + describe(l.writeError) });          // nothing more is written; the next load tries again
    const next = applyChange(l.profile, c.change);
    if (!next) return { ok: true, profile: l.profile, changed: false, notSaved: notSavedOf(store) };
    try {
      const saved = await store.saveProfile(next, { reason: 'trainer' });
      return { ok: true, profile: saved, changed: true, notSaved: notSavedOf(store) };
    } catch (e) {
      if (e && e.code === 'store.conflict') continue;          // another tab saved between the read and the write: read again (its change is kept, ours applied on top)
      return failFrom(e);
    }
  }
  return fail('conflict');
}

/** Make `id` the active trainer (SWITCH TRAINER). A profile of a newer build may be active (the hub shows it read-only); one that cannot be read may not. */
export async function setActiveTrainer(store, id) {
  if (typeof id !== 'string' || !id) return fail('not-found', 'no trainer id was given');
  let list;
  try { list = await store.listProfiles(); } catch (e) { return failFrom(e); }
  const row = list.find((r) => r && r.id === id);
  if (!row) return fail('not-found');
  if (row.corrupt) return fail('unreadable');
  try { await store.setActiveId(id); } catch (e) { return failFrom(e); }
  return { ok: true };
}

/** Every readable trainer, in the store's order. Never throws. */
export async function listTrainers(store) {
  const out = [];
  let list, activeId = null;
  try { list = await store.listProfiles(); } catch (_e) { return out; }
  try { activeId = await store.getActiveId(); } catch (_e) { activeId = null; }
  for (const s of list) {
    if (!s || !s.id || s.corrupt) continue;
    let r;
    try { r = await store.loadProfile(s.id); } catch (_e) { continue; }
    if (!r || !r.ok) continue;
    const p = r.profile;
    out.push({ id: p.id, name: typeof p.trainerName === 'string' ? p.trainerName : '', avatar: avatarOf(p), card: cardOf(p), readOnly: !!r.readOnly, active: p.id === activeId });
  }
  return out;
}
