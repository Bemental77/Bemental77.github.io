// pokemonarena/js/trainer_ctl.js -- THE TRAINER app's side effects: what the ROM gives the pickers, the store's trainers, saving, LATER, SWITCH TRAINER (trainer_hub.js is the pure half).
//
// createCtl(env) (pokemonarena/INAPP.md "The app interface": env.app is this app's model, env.run carries out effects, env.refreshData re-reads the store for every screen).
//
// WHAT IT HANDS THE MODEL (as soon as it is made, and again on every enter): setChoices (the ROM's looks: world.ow.avatars; the battle figures: trainer_figures.js frontChoices / backChoices;
// the 52 trainer heads; the pack's legal species and their names), setSeed (env.freshSeed(): a new trainer's default look), setMascot (hub_data.js pickMascot of today: the default
// partner), setStoredLook (center_look.js loadLook: this browser's look, the default look when there is one), setTrainers (the store's trainers, read in full: name, avatar, card, record).
//
// EFFECTS IT CARRIES OUT (app 'trainer'): 'opened' (hand the model what it needs), 'later' (sessionStorage 'arena.welcome' = 'later': not asked again in this tab), 'save' (the new-trainer
// screens' YES: trainer_store.js createTrainer / updateTrainer; then the look to localStorage 'arena.avatar' (center_look.js saveLook), env.refreshData(), the success sound, the model's
// saved() and its move back), 'update' (the editor: updateTrainer), 'switch' (setActiveTrainer, then refreshData).
//
// Storage keys: sessionStorage 'arena.welcome' (written 'later'), localStorage 'arena.avatar' (center_look.js LOOK_KEY: written with the trainer's look). Every use is inside a try.

import { centerWorld } from './center_world.js';
import { frontChoices, backChoices } from './trainer_figures.js';
import { TRAINER_HEAD_COUNT } from './speciesgfx.js';
import { pickMascot } from './hub_data.js';
import { loadLook, saveLook } from './center_look.js';
import { cardOf } from './trainer_card.js';
import { LATER } from './trainer_hub.js';

/** How a ROM class name is shown on a chip: the ROM font has no {PK}{MN} token here, so it is spelt; the sex signs become the font's own tokens. */
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

/** The store's trainers in full (what the card shows): { activeId, list }. Never throws (null: the store could not be read; the model falls back to hub data). */
export async function readTrainers(store) {
  if (!store) return null;
  try {
    const activeId = await store.getActiveId().catch(() => null);
    const out = [];
    for (const s of await store.listProfiles()) {
      if (!s || !s.id || s.corrupt) continue;
      let r; try { r = await store.loadProfile(s.id); } catch (_e) { continue; }
      if (!r || !r.ok || !r.profile) continue;
      const p = r.profile, st = p.stats || {};
      out.push({ id: p.id, name: p.trainerName, readOnly: !!r.readOnly, avatar: p.avatar || null, card: cardOf(p), rec: { wins: st.wins | 0, losses: st.losses | 0 } });
    }
    return { activeId, list: out };
  } catch (_e) { return null; }
}

export function createCtl(env) {
  const app = env.app;
  let stamped = false;
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
    const store = env.store() || (env.whenStore ? await env.whenStore() : null);
    const t = await readTrainers(store);
    app.setTrainers(t);
    env.redraw();
  }
  hand();
  refreshTrainers();

  return {
    enter() { hand(); refreshTrainers(); env.redraw(); },
    effect(eff) {
      switch (eff && eff.type) {
        case 'opened': hand(); env.redraw(); return undefined;
        case 'later': try { if (env.session) env.session.setItem(LATER.key, LATER.value); } catch (_e) { /* storage refused: asked again next time */ } return undefined;
        default: return undefined;
      }
    },
    leave() {},
    dispose() {},
  };
}
