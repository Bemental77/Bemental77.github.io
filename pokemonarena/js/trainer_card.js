// pokemonarena/js/trainer_card.js -- THE TRAINER CARD: what a profile says about the trainer beyond the name and the portrait (profile schema 6, `profile.card`).
//
// The owner (2026-11-18): "when a person navigates to the page, they are greeted with the pokemon arena app and asked to create a profile - we need an entire profile creation
// suite, avatar, battle figure, nick name, everything". The NAME is `profile.trainerName` and the PORTRAIT is `profile.avatar` (both schema 1). Everything else the new-trainer
// screens choose lives here, in ONE object:
//
//   card = {
//     made:    boolean          the player finished the NEW TRAINER screens for this profile (a profile from before schema 6 is false: the hub offers the screens again, pre-filled)
//     look:    string | null    how the trainer walks around in the Trainer Center: a look code of center_look.js ('w' + six base-36 digits = a ROM overworld graphics id; Contract 4)
//     front:   int | null       the BATTLE FIGURE others see: a ROM trainer FRONT picture index (speciesgfx.js trainerFront); trainer_figures.js says which ones a battle can show
//     back:    int | null       the battle figure the player sees from behind in their own battles: a ROM trainer BACK picture index (speciesgfx.js trainerBack, 0..7 in this ROM)
//     partner: int | null       the favourite Pokemon: a species id (the hub's title screen shows it, the card shows it). Whether this ROM has the species is the pack's business
//   }
//
// null always means "not chosen": every reader falls back to the default it had before schema 6 (the first avatar, the ROM's default back picture, the day's mascot ...).
// WHICH ids exist is the ROM's business, never this file's: here only the SHAPE is checked, as profile.js checks `avatar`. Unknown keys inside `card` are kept by profile.js in
// `card._unknown` (the bag convention of every other block), so a newer build's card survives a round trip through this one.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness.

/** The keys of a card, in the order they are written. */
export const CARD_KEYS = Object.freeze(['made', 'look', 'front', 'back', 'partner']);
/** A look code (center_look.js LOOK_RE, repeated here so this file imports nothing). */
export const CARD_LOOK_RE = /^w[0-9a-z]{6}$/;
/** The largest picture index / species id a card may name (the ROM decides which exist). */
export const CARD_LIMITS = Object.freeze({ front: 255, back: 255, partner: 65535 });

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The card of a profile that has chosen nothing yet (what MIGRATIONS[5] gives every profile from before schema 6). */
export function emptyCard() { return { made: false, look: null, front: null, back: null, partner: null }; }

/** One field's problem, or null. `key` is one of CARD_KEYS. */
export function cardFieldIssue(key, v) {
  switch (key) {
    case 'made': return typeof v === 'boolean' ? null : 'made must be true or false';
    case 'look': return v === null || (typeof v === 'string' && CARD_LOOK_RE.test(v)) ? null : 'look must be null or a look code (w + six base-36 digits)';
    case 'front': return v === null || isInt(v, 0, CARD_LIMITS.front) ? null : 'front must be null or a whole number 0..' + CARD_LIMITS.front;
    case 'back': return v === null || isInt(v, 0, CARD_LIMITS.back) ? null : 'back must be null or a whole number 0..' + CARD_LIMITS.back;
    case 'partner': return v === null || isInt(v, 1, CARD_LIMITS.partner) ? null : 'partner must be null or a species id 1..' + CARD_LIMITS.partner;
    default: return 'unknown card key ' + key;
  }
}

/** Every problem of a stored card (profile.js checkProfile adds them under the code 'profile.card'): [{ path, message }]. `_unknown` is allowed (profile.js checks bags). */
export function cardIssues(card) {
  if (!isObj(card)) return [{ path: 'card', message: 'card must be an object' }];
  const out = [];
  for (const k of CARD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(card, k)) { out.push({ path: 'card.' + k, message: 'card.' + k + ' is missing' }); continue; }
    const why = cardFieldIssue(k, card[k]);
    if (why) out.push({ path: 'card.' + k, message: why });
  }
  for (const k of Object.keys(card)) if (!CARD_KEYS.includes(k) && k !== '_unknown') out.push({ path: 'card.' + k, message: 'unexpected key ' + k });
  return out;
}

/** Repair: a field that is missing or wrong becomes its empty value. -> { card, repaired: [key...] }. The `_unknown` bag is NOT handled here (profile.js does bags). */
export function repairCard(input) {
  const src = isObj(input) ? input : {}, card = emptyCard(), repaired = [];
  for (const k of CARD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k) && !cardFieldIssue(k, src[k])) card[k] = src[k];
    else if (Object.prototype.hasOwnProperty.call(src, k) || isObj(input)) repaired.push(k);
  }
  return { card, repaired };
}

/** A patch for a card (what the new-trainer screens and the trainer card save): only CARD_KEYS, each valid. -> { ok: true, patch } | { ok: false, key, message }. */
export function checkCardPatch(patch) {
  if (!isObj(patch)) return { ok: false, key: null, message: 'a card patch is an object' };
  const out = {};
  for (const k of Object.keys(patch)) {
    if (!CARD_KEYS.includes(k)) return { ok: false, key: k, message: 'unknown card key ' + k };
    const why = cardFieldIssue(k, patch[k]);
    if (why) return { ok: false, key: k, message: why };
    out[k] = patch[k];
  }
  return { ok: true, patch: out };
}

/** The card of a profile as a reader should see it: always all five keys (a profile from an older build, or none at all, reads as the empty card). Never throws. */
export function cardOf(profile) {
  const c = profile && isObj(profile.card) ? profile.card : null;
  if (!c) return emptyCard();
  return repairCard(c).card;
}

/** Has this profile been through the NEW TRAINER screens? */
export const isMade = (profile) => cardOf(profile).made === true;
