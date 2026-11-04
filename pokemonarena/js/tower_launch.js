// pokemonarena/js/tower_launch.js -- THE SEAM: how the Tower gets from "the hub shows a floor" to "the floor's battle is on screen", and back. Pure ES module: strings and a callback, no DOM, no location.
//
// Today the fight is its own page: launchFloorBattle(run) hands battle.html a Tower address (towerBattleHref) and the battle page's thin wrapper (battle_boot.js) reads it back (parseTowerParams) and runs the
// SAME functions the hub could call directly (tower_session.js startTowerFloor, tower_fight.js createTowerFight). When the hub hosts battles in its own page, THIS FILE is what changes: launchFloorBattle mounts
// the battle in place instead of navigating, and returnToTower closes it. Nothing else in the Tower names a page, an address or `location`.
//
//   launchFloorBattle(run, { navigate, profileId })   -> the address it went to (today); the page to mount the fight in (tomorrow)
//   returnToTower({ navigate })                        -> back to the hub's Tower screens
//   towerBattleHref(run, { profileId }) / parseTowerParams(URLSearchParams)   the address contract: battle.html?tower=1&floor=N&run=<run seed>&life=<lives spent>[&p=<profile id>]

import { BATTLE_PAGE } from './editor_links.js';
import { CONFIG } from './tower_config.js';

export const HUB_PAGE_URL = '/pokemonarena/';
export const TOWER_HUB_URL = HUB_PAGE_URL + '#tower';
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/** The address of the fight a run is waiting for. Throws RangeError for anything outside the contract. */
export function towerBattleHref(run, { profileId = null, cfg = CONFIG } = {}) {
  if (!run || !isU32(run.seed) || !Number.isInteger(run.floor) || run.floor < 1 || run.floor > cfg.floors) throw new RangeError('a Tower run with a seed and a floor is needed');
  const q = ['tower=1', 'floor=' + run.floor, 'run=' + run.seed];
  const life = Number.isInteger(run.livesUsed) && run.livesUsed > 0 ? Math.min(run.livesUsed, 1000) : 0;
  if (life) q.push('life=' + life);
  if (profileId !== null && profileId !== undefined) { if (!ID.test(profileId)) throw new RangeError('profileId must be a profile id'); q.push('p=' + encodeURIComponent(profileId)); }
  return BATTLE_PAGE + '?' + q.join('&');
}

/**
 * Read the Tower part of an address. -> { ok: true, tower: null } (no `tower` parameter: a regular battle) | { ok: true, tower: { floor, run, life, profileId } } | { ok: false, error: { param, title, message } }
 * Strict: `tower` must be exactly "1"; floor, run and life are plain decimal numbers in range; the profile id has the profile id alphabet. Nothing is echoed back.
 */
export function parseTowerParams(q, cfg = CONFIG) {
  const has = (k) => q.has(k);
  const bad = (param, message) => ({ ok: false, error: { param, title: 'That Tower address cannot be used', message } });
  const any = ['tower', 'floor', 'run', 'life', 'p'].some(has);
  if (!any) return { ok: true, tower: null };
  if (!has('tower')) return bad('tower', 'The Tower fight is missing its tower=1 parameter.');
  if (q.get('tower') !== '1') return bad('tower', 'The tower parameter must be 1.');
  const num = (k, lo, hi, required) => { if (!has(k)) return required ? null : lo; const s = q.get(k); if (!/^\d{1,10}$/.test(s)) return null; const n = Number(s); return n >= lo && n <= hi ? n : null; };
  const floor = num('floor', 1, cfg.floors, true);
  if (floor === null) return bad('floor', 'The floor must be a whole number from 1 to ' + cfg.floors + '.');
  const run = num('run', 0, 0xffffffff, true);
  if (run === null) return bad('run', 'The run must be a whole number from 0 to 4294967295.');
  const life = num('life', 0, 1000, false);
  if (life === null) return bad('life', 'The life count must be a whole number from 0 to 1000.');
  let profileId = null;
  if (has('p')) { const p = q.get('p'); if (!ID.test(p)) return bad('p', 'The profile in the address is not a profile id.'); profileId = p; }
  return { ok: true, tower: { floor, run, life, profileId } };
}

/** Go and fight the floor the run is waiting for. `navigate(url)` is the page's navigation. Returns the address. */
export function launchFloorBattle(run, { navigate, profileId = null, cfg = CONFIG } = {}) {
  const url = towerBattleHref(run, { profileId, cfg });
  if (typeof navigate !== 'function') throw new TypeError('launchFloorBattle needs navigate(url)');
  navigate(url);
  return url;
}

/** Leave the fight for the hub's Tower screens. `step` is what the run is waiting for ('offer': the buff offer opens; 'over' / 'won': the last run's result opens; anything else: the Tower's status). */
export function returnToTower({ navigate, step = null } = {}) {
  if (typeof navigate !== 'function') throw new TypeError('returnToTower needs navigate(url)');
  const url = step === 'offer' ? HUB_PAGE_URL + '#tower-offer' : step === 'over' || step === 'won' ? HUB_PAGE_URL + '#tower-last' : TOWER_HUB_URL;
  navigate(url);
  return url;
}

/** Leave for the hub's main menu. */
export function returnToHub({ navigate } = {}) {
  if (typeof navigate !== 'function') throw new TypeError('returnToHub needs navigate(url)');
  navigate(HUB_PAGE_URL);
  return HUB_PAGE_URL;
}
