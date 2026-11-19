// pokemonarena/js/trainer_ctl.js -- THE TRAINER app's side effects: what the ROM gives the pickers, the store's trainers, saving, LATER, SWITCH TRAINER (trainer_hub.js is the pure half).
//
// createCtl(env) (pokemonarena/INAPP.md "The app interface": env.app is this app's model, env.run carries out effects, env.refreshData re-reads the store for every screen).
//
// WHAT IT HANDS THE MODEL (when it is made, and again on every enter / 'opened'): setChoices (the ROM's looks: world.ow.avatars; the battle figures: trainer_figures.js frontChoices /
// backChoices, always read, never a list of its own; the 52 trainer heads; the pack's legal species and their names), setSeed (env.freshSeed(): a new trainer's default look), setMascot
// (hub_data.js pickMascot of today: the default partner), setStoredLook (center_look.js loadLook: this browser's look, the default look when there is one), setTrainers (trainer_store.js
// listTrainers: every trainer with its name, portrait and card).
//
// EFFECTS IT CARRIES OUT (app 'trainer'):
//   'opened'   hand the model what it needs (above)
//   'later'    sessionStorage 'arena.welcome' = 'later': the first-visit opening is not asked again in this tab
//   'save'     the new-trainer screens' YES: trainer_store.js createTrainer (a new trainer, made the active one) or updateTrainer (a profile from before schema 6, pre-filled); then the look
//              to localStorage 'arena.avatar' (center_look.js saveLook: the Trainer Center reads it), env.refreshData(), the success sound, and the model's saved() (its move back)
//   'update'   the editor's A: updateTrainer(id, patch); the look to 'arena.avatar' too when it is the active trainer's
//   'switch'   setActiveTrainer, then refreshData
// A refusal of the store is handed to the model as saved({ ok: false, why }) (or failed(why) for a switch): its words stay in the picture and the screen stays.
//
// Storage keys: sessionStorage 'arena.welcome' (written 'later'), localStorage 'arena.avatar' (center_look.js LOOK_KEY). Every use is inside a try.

import { centerWorld } from './center_world.js';
import { frontChoices, backChoices } from './trainer_figures.js';
import { TRAINER_HEAD_COUNT } from './speciesgfx.js';
import { pickMascot } from './hub_data.js';
import { loadLook, saveLook } from './center_look.js';
import { createTrainer, updateTrainer, setActiveTrainer, listTrainers } from './trainer_store.js';
import { LATER } from './trainer_hub.js';

/** How a ROM class name is shown on a chip: the ROM font has no {PK}{MN} token here, so it is spelt; the sex signs and the accent become the font's own tokens. */
export function classLabel(cls) {
  return String(cls || '').replace(/\{PK\}\{MN\}/g, 'PKMN').replace(/♂/g, '{MALE}').replace(/♀/g, '{FEMALE}').replace(/é/g, '{E}').trim();
}
/** A species name as the partner picker lists it. */
export const speciesLabel = (name) => String(name || '').replace(/é/g, '{E}').replace(/♂/g, '{MALE}').replace(/♀/g, '{FEMALE}');

/** What the pickers pick from, decoded from the ROM and the pack. Never throws: what cannot be read is an empty list (the model then says it is loading / has nothing). */
export function choicesOf(rom, pack) {
  let looks = [], fronts = [], backs = [], species = [];
  try { looks = centerWorld(rom).world.ow.avatars.slice(); } catch (_e) { looks = []; }
  try { fronts = frontChoices(rom).map((c) => ({ pic: c.pic, cls: classLabel(c.cls) })); } catch (_e) { fronts = []; }
  try { backs = backChoices(rom).slice(); } catch (_e) { backs = []; }
  try { species = (pack && Array.isArray(pack.species) ? pack.species : []).map((s, id) => (s && s.legal && s.name ? { id, name: speciesLabel(s.name) } : null)).filter(Boolean); } catch (_e) { species = []; }
  return { looks, fronts, backs, heads: TRAINER_HEAD_COUNT, species };
}

/** trainer_store.js's refusal codes -> the model's words (trainer_hub.js WORDS.failed). */
export const WHY = Object.freeze({ 'read-only': 'readonly', 'not-saved': 'notsaved', conflict: 'conflict', name: 'invalid', avatar: 'invalid', card: 'invalid', 'not-found': 'failed', unreadable: 'failed', store: 'failed' });
export const whyOf = (code) => WHY[code] || 'failed';

export function createCtl(env) {
  const app = env.app;
  let stamped = false;
  const storeNow = async () => { try { return env.store() || (typeof env.whenStore === 'function' ? await env.whenStore() : null); } catch (_e) { return null; } };
  function hand() {
    try {
      if (!stamped) {
        app.setChoices(choicesOf(env.rom, env.pack));
        app.setMascot(pickMascot(env.pack, Math.floor(Date.now() / 86400000)));
        stamped = true;
      }
      app.setSeed(env.freshSeed());
      app.setStoredLook(loadLook(env.storage));
    } catch (e) { console.warn('[trainer] could not read the ROM choices:', e); }
  }
  async function refreshTrainers() {
    const store = await storeNow();
    if (!store) { app.setTrainers(null); env.redraw(); return; }
    const list = await listTrainers(store);
    const act = list.find((t) => t.active);
    app.setTrainers({ activeId: act ? act.id : null, list: list.map((t) => ({ id: t.id, name: t.name, readOnly: t.readOnly, avatar: t.avatar, card: t.card })) });
    env.redraw();
  }
  async function afterWrite(look, ok) {
    if (look) { try { saveLook(env.storage, look); } catch (_e) { /* the Center falls back to the card's look */ } }
    await refreshTrainers();
    try { await env.refreshData(); } catch (_e) { /* the next refresh shows it */ }
    if (ok) env.sound.sfx('se_success');
  }
  async function save(eff) {
    const store = await storeNow();
    if (!store) { env.run(app.saved({ ok: false, why: 'nostore' })); env.redraw(); return; }
    const input = { name: eff.name, avatar: eff.avatar, card: eff.card };
    const r = eff.mode === 'update' && eff.profileId ? await updateTrainer(store, eff.profileId, input) : await createTrainer(store, input);
    if (!r || !r.ok) { env.run(app.saved({ ok: false, why: whyOf(r && r.code), message: r && r.message })); env.redraw(); return; }
    await afterWrite(eff.card && eff.card.look, true);
    env.run(app.saved({ ok: true }));
    env.redraw();
  }
  async function update(eff) {
    const store = await storeNow();
    if (!store) { env.run(app.saved({ ok: false, why: 'nostore' })); env.redraw(); return; }
    const r = await updateTrainer(store, eff.profileId, eff.patch || {});
    if (!r || !r.ok) { env.run(app.saved({ ok: false, why: whyOf(r && r.code), message: r && r.message })); env.redraw(); return; }
    let look = null;
    if (eff.patch && eff.patch.card && eff.patch.card.look) { const act = await store.getActiveId().catch(() => null); if (act === eff.profileId) look = eff.patch.card.look; }
    await afterWrite(look, true);
    env.run(app.saved({ ok: true }));
    env.redraw();
  }
  async function switchTo(eff) {
    const store = await storeNow();
    const r = store ? await setActiveTrainer(store, eff.id) : { ok: false, code: 'store' };
    if (!r.ok) { app.failed(whyOf(r.code)); env.redraw(); return; }
    let look = null;
    try { const t = (await listTrainers(store)).find((x) => x.id === eff.id); look = t && t.card ? t.card.look : null; } catch (_e) { look = null; }
    await afterWrite(look, false);
    env.redraw();
  }
  hand();
  refreshTrainers();

  return {
    enter() { hand(); refreshTrainers(); env.redraw(); },
    effect(eff) {
      switch (eff && eff.type) {
        case 'opened': hand(); env.redraw(); return refreshTrainers();
        case 'data': return refreshTrainers();
        case 'later': try { if (env.session) env.session.setItem(LATER.key, LATER.value); } catch (_e) { /* storage refused: asked again next time */ } return undefined;
        case 'save': return save(eff);
        case 'update': return update(eff);
        case 'switch': return switchTo(eff);
        default: return undefined;
      }
    },
    leave() {},
    dispose() {},
    /** (tests) the trainers read again from the store. */
    refresh: refreshTrainers,
  };
}
