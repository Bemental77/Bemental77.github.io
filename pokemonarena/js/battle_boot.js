// pokemonarena/js/battle_boot.js -- page controller for /pokemonarena/battle.html.
//
// Fetches the SoulGold v1.1.1 ROM the site already serves (progress bar, length + SHA-256 gate), reads the URL contract, builds the two
// teams, the match controller (matchctl.js) and the scene (scene.js), and runs the battle at the Game Boy Advance's own frame rate.
// Input is the shared input layer (input.js): keyboard, mouse, touch and controller all arrive as the same actions.
// No third-party code, no CDN. Import-safe in Node: nothing touches `document` unless it exists, so tools/pokemonarena_scene_test.mjs
// unit-tests parseBattleQuery / resolveBattle / fitScale directly.
//
// URL CONTRACT (battle.html?...)
//   team=<ARENA1.* team code>   your team (decoded with teamcode.js, pinned-ROM check ON, validated against the ruleset)
//   foe=random | <ARENA1.* code>  the opponent's team (default random: a random legal team from the ruleset)
//   seed=<u32>                  the battle seed (default: drawn once from crypto and written back into the address bar)
//   format=6v6 | 3v3            6v6 = every Pokemon of both teams; 3v3 = team preview, each side picks 3 (Quick Battle defaults to 3v3)
//   cpu=easy | normal | hard    the opponent's skill (default normal)
// With no parameters the page starts a Quick Battle: two random legal teams under arena-gen3-standard. Anything that is not exactly one
// of the forms above is refused with an error screen; the offending VALUE IS NEVER ECHOED, executed or put into the DOM.
//
// Test hook: window.__arenaBattle (see makeHook).

import { loadVerifiedRom, romUrl, RomLoadError } from './romfetch.js';
import { loadPack } from './tables.js';
import { createBattleUi } from './battle_ui.js';
import { loadBattleText } from './battle_text.js';
import { createMatchController, randomTeam, teamFromMons, FORMATS } from './matchctl.js';
import { createScene, GBA_FPS, RESULT_OPTIONS } from './scene.js';
import { decodeTeamCode, validateDecodedTeam } from './teamcode.js';
import { DEFAULT_RULESET_ID } from './rules.js';
import { PINNED } from './rom.js';
import { AI_LEVELS, createAi } from './ai.js';
import { createControlsDialog } from './controls_dialog.js';
import { describeRomError, showRomError } from './rom_error.js';
import { watchHints } from './hints.js';
import { createAnimSettings, parseAnimQuery } from './anim_settings.js';
import { prewarmSystem, trainerChoices } from './anim_sys.js';
import { matchFromSummary, onlineMatchId } from './career_stats.js';  // ST1: the finished match as the career wants it (and the id of a battle against a person)
import { cleanName } from './netmatch.js';                              // an online opponent's name as the career keeps it (the same reduction the match used)
import { createResumeStore, resumeKey, navigationType } from './battle_resume.js';       // W1 fix D11: a reload mid-battle resumes it
import { parseOnlineQuery, createOnline } from './online.js';                         // two players, one battle (netmatch.js + lib/netplay.js); see ONLINE.md
import { engineFingerprint } from './online_match.js';
import { fitScale, fitPicture, createFullscreen, PROMPT_ROOM } from './screenfit.js';       // the picture fills its room; the Fullscreen switch

export { GBA_FPS };
const STEP_MS = 1000 / GBA_FPS;
const SCREEN_W = 240, SCREEN_H = 160;
export const CPU_NAMES = Object.freeze({ easy: 'CPU Easy', normal: 'CPU Normal', hard: 'CPU Hard' });
const CODE_RE = /^ARENA1\.[A-Za-z0-9_-]{1,1000}\.[0-9a-fA-F]{4}$/;
const MAX_PARAM = 1100;

/* ------------------------------------------------------------------------------------------ pure helpers */

// How big the picture is drawn: the whole room it is given, snapped to a whole device-pixel scale only when that costs under 6 % (screenfit.js has the rule and why).
export { fitScale };

/**
 * -> { ok: true, params: { team, foe, seed, format, cpu, quick } } | { ok: false, error: { param, title, message } }
 * `team` / `foe` stay STRINGS here (a team code or null / 'random'); nothing is decoded or echoed. First problem wins.
 */
export function parseBattleQuery(search) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch (_e) { return bad('url', 'The address could not be read', 'The page address is not valid.'); }
  const get = (k) => (q.has(k) ? q.get(k) : null);
  const team = get('team'), foe = get('foe'), seedS = get('seed'), format = get('format'), cpu = get('cpu'), speed = get('speed');
  if (team !== null && !(typeof team === 'string' && team.length <= MAX_PARAM && CODE_RE.test(team.replace(/\s+/g, '')))) return bad('team', 'That team code cannot be used', 'The team in the address is not a Pokemon Arena team code (it must look like ARENA1.<letters>.<4 hex digits>). It was not read or run.');
  if (foe !== null && foe !== 'random' && !(typeof foe === 'string' && foe.length <= MAX_PARAM && CODE_RE.test(foe.replace(/\s+/g, '')))) return bad('foe', 'That opponent cannot be used', 'The opponent in the address is neither "random" nor a Pokemon Arena team code. It was not read or run.');
  let seed = null;
  if (seedS !== null) {
    if (!/^\d{1,10}$/.test(seedS) || Number(seedS) > 4294967295) return bad('seed', 'That battle seed cannot be used', 'The seed must be a whole number from 0 to 4294967295.');
    seed = Number(seedS) >>> 0;
  }
  if (format !== null && !Object.prototype.hasOwnProperty.call(FORMATS, format)) return bad('format', 'That battle format cannot be used', 'The format must be 6v6 or 3v3.');
  if (cpu !== null && !AI_LEVELS.includes(cpu)) return bad('cpu', 'That CPU level cannot be used', 'The CPU level must be easy, normal or hard.');
  // `speed` is the text speed (slow / mid / fast) or, as a number, the animation BATTLE SPEED (1 / 2 / 4; anim_settings.js reads that form); `anim` and `animskip` are 0 / 1
  if (speed !== null && !['slow', 'mid', 'fast', '1', '2', '4'].includes(speed)) return bad('speed', 'That text speed cannot be used', 'The text speed must be slow, mid or fast.');
  if (parseAnimQuery(search).errors.includes('anim')) return bad('anim', 'That animation setting cannot be used', 'The animation setting must be 0 or 1.');
  if (parseAnimQuery(search).errors.includes('animskip')) return bad('animskip', 'That animation setting cannot be used', 'The animation skip setting must be 0 or 1.');
  const quick = team === null;
  return { ok: true, params: { team: team === null ? null : team.replace(/\s+/g, ''), foe: foe === null ? 'random' : foe === 'random' ? 'random' : foe.replace(/\s+/g, ''), seed, format: format || (quick ? '3v3' : '6v6'), cpu: cpu || 'normal', speed: ['slow', 'mid', 'fast'].includes(speed) ? speed : 'fast', quick } };
  function bad(param, title, message) { return { ok: false, error: { param, title, message } }; }
}

const mix = (a, b) => ((Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0);

/**
 * Decode / generate both teams and settle the rules. `pack` = tables.js pack. Returns { ok: true, spec } where spec feeds
 * createMatchController and createScene, or { ok: false, error: { param, title, message, detail } }. Never throws on hostile input.
 */
export async function resolveBattle(pack, params, deps = {}) {
  const decode = deps.decodeTeamCode || decodeTeamCode;
  const fail = (param, title, message, detail) => ({ ok: false, error: { param, title, message, detail: detail || '' } });
  const seed = params.seed >>> 0;
  const pick = FORMATS[params.format].pick;
  let ruleset = DEFAULT_RULESET_ID;
  let mineTeam = null, foeTeam = null;
  const reasons = (v) => v.reasons.slice(0, 3).map((r) => r.message || r.code).join('; ');
  if (params.team !== null) {
    const r = await decode(params.team, { expectRomSha256: PINNED.sha256 });
    if (!r.ok) return fail('team', 'That team code cannot be used', r.message || 'The code could not be decoded.', 'code ' + String(r.code || '').slice(0, 40));
    const v = validateDecodedTeam(r.team, pack);
    if (!v.ok) return fail('team', 'That team is not legal here', 'The team breaks the rules of its ruleset: ' + reasons(v), (v.reasons.length) + ' problem(s) found');
    ruleset = r.team.ruleset; mineTeam = teamFromMons(r.team.mons, ruleset);
  }
  const size = (n) => Math.max(1, Math.min(6, n));
  if (params.foe !== 'random') {
    const r = await decode(params.foe, { expectRomSha256: PINNED.sha256 });
    if (!r.ok) return fail('foe', 'That opponent cannot be used', r.message || 'The code could not be decoded.', 'code ' + String(r.code || '').slice(0, 40));
    if (mineTeam && r.team.ruleset !== ruleset) return fail('foe', 'The two teams use different rules', 'Your team and the opponent\'s team were built for different rulesets, so they cannot play each other.');
    if (!mineTeam) ruleset = r.team.ruleset;
    const v = validateDecodedTeam(r.team, pack);
    if (!v.ok) return fail('foe', 'That opponent is not legal here', 'The opponent breaks the rules of its ruleset: ' + reasons(v), (v.reasons.length) + ' problem(s) found');
    foeTeam = teamFromMons(r.team.mons, ruleset);
  }
  try {
    if (!mineTeam) mineTeam = randomTeam(pack, mix(seed, 1), size(foeTeam ? foeTeam.recs.length : 6), ruleset);
    if (!foeTeam) foeTeam = randomTeam(pack, mix(seed, 2), size(Math.max(mineTeam.recs.length, pick || 1)), ruleset);
  } catch (e) { return fail('team', 'A random team could not be built', 'No legal random team exists under this ruleset.', String(e && e.message ? e.message : e).slice(0, 80)); }
  if (pick && (mineTeam.recs.length < pick || foeTeam.recs.length < pick)) return fail('format', 'Not enough Pokemon for 3v3', 'A 3v3 battle needs at least 3 Pokemon on each team. Use format=6v6, or add Pokemon to the team.');
  return {
    ok: true,
    spec: {
      pack, ruleset, teams: [mineTeam.recs, foeTeam.recs], meta: [mineTeam.meta, foeTeam.meta], seed, pick, names: ['You', CPU_NAMES[params.cpu]],
      sides: [{ kind: 'human' }, { kind: 'cpu', level: params.cpu, seed: mix(seed, 3) }], cpu: params.cpu, format: params.format, trainer: CPU_NAMES[params.cpu],
    },
  };
}

/* ------------------------------------------------------------------------------------------------ the page */

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

async function main() {
  const [{ createInput }, { enableDomNav }, cries, soundMod] = await Promise.all([import('./input.js'), import('./uinav.js'), import('./cries.js'), import('./sound_system.js').catch((e) => { console.warn('[sound] sound_system.js did not load; the old switch is used:', e); return {}; })]);
  const $ = (id) => document.getElementById(id);
  const canvas = $('battle'), ctx = canvas.getContext('2d', { alpha: false });
  const els = { boot: $('boot'), bar: $('bar'), bootText: $('bootText'), err: $('error'), errTitle: $('errTitle'), errMsg: $('errMsg'), errDetail: $('errDetail'), retry: $('retry'), note: $('note'), top: $('top'), padA: $('dpad'), padB: $('ab'), sound: $('soundBtn'), menu: $('menuBtn') };
  const hook = window.__arenaBattle = { state: 'boot', kind: null, error: null, params: null, seed: null };
  const mbs = (n) => (n / 1048576).toFixed(1);
  const input = createInput();
  let nav = null, scene = null, ctl = null, ui = null, packRef = null, romBytes = null, last = null;
  let touchPad = false;
  // W1: the pause menu's CONTROLS row opens the shared Controls dialog. While it is open the clock stops and the scene hears nothing (the B
  // that closes the dialog must not also act on the battle), then the pause menu comes back where it was (scene.js openMenu('CONTROLS')).
  let controlsOpen = false, controlsDone = null;
  // WHO holds the pause (the clock stops and the scene hears nothing while it is true): the Controls dialog, the Sound panel and the Open-to-battles dialogs can be up TOGETHER (a challenge
  // arrives while Controls is open), so it is a SET of owners, not one boolean: closing one dialog never un-pauses the battle behind another that is still open
  const pauseOwners = new Set();
  const setPaused = (who, v) => { if (v) pauseOwners.add(who); else pauseOwners.delete(who); controlsOpen = pauseOwners.size > 0; hook.controlsOpen = controlsOpen; };
  const ctlDlg = createControlsDialog({
    input, enableDomNav,
    onOpen: () => { setPaused('controls', true); },
    onClose: () => { setPaused('controls', false); const d = controlsDone; controlsDone = null; setTimeout(() => { if (!controlsOpen) { try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } if (d) d(); }, 0); },
  });
  const openControls = (done) => { controlsDone = typeof done === 'function' ? done : null; ctlDlg.open().then((ok) => { if (!ok && controlsDone) { const d = controlsDone; controlsDone = null; d(); } }); };

  /* ---- errors ---- */
  function showError({ title, message, detail, kind, retry, param, tech }) {
    hook.state = 'error'; hook.kind = kind || 'internal'; hook.error = message; hook.param = param || null;
    canvas.hidden = true;
    showRomError({ boot: els.boot, err: els.err, errTitle: els.errTitle, errMsg: els.errMsg, errDetail: els.errDetail, retry: els.retry }, { kind: kind || 'internal', title, message, detail, retry, tech: tech || '' });          // W1 D7: the one shared error experience (rom_error.js)
    { const q = $('quickBtn'); if (q) q.hidden = kind !== 'params'; }          // 'Quick Battle' belongs to a refused ADDRESS, not to a missing game file
    document.body.dataset.state = 'error';
    if (!nav) { try { nav = enableDomNav(els.err, { input, onBack: () => { location.href = '/pokemonarena/'; } }); } catch (_e) { nav = null; } }
    else { try { nav.refresh(); } catch (_e) { /* ignore */ } }
    if (nav) { try { nav.focusFirst(); } catch (_e) { /* ignore */ } }
    fit();
  }
  const romError = (e) => describeRomError(e);

  /* ---- scaling ---- */
  const coarse = () => !!window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches);
  // The picture takes the room it is given (screenfit.js fitPicture): a phone held upright runs it edge to edge, fullscreen gives it the whole viewport.
  // The old rule here was a whole scale only (floor), which left a 390 px phone a 324 px picture and a 360 px phone a 244 px one.
  function fit() {
    hook.scale = fitPicture({ doc: document, win: window, canvas, top: els.top, padA: els.padA, padB: els.padB, touchPad, hint: (!touchPad && document.body.dataset.state === 'ready') ? 40 + PROMPT_ROOM : 0 });
    try { syncChips(); } catch (_e) { /* the chips are placed again on the next frame */ }
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  // the Fullscreen switch: the header button, and the floating one that stands in for it while the header is hidden (a phone held sideways, fullscreen)
  const fullscreen = hook.fullscreen = createFullscreen({ doc: document, win: window, buttons: [$('fullBtn'), $('fullExit')], onChange: () => { fit(); }, storage: (() => { try { return window.sessionStorage; } catch (_e) { return null; } })() });
  document.addEventListener('fullscreenchange', () => setTimeout(fit, 120)); document.addEventListener('webkitfullscreenchange', () => setTimeout(fit, 120));       // the viewport settles a moment after the event (iOS reports the old size first)

  /* ---- sound: muted by default; an AudioContext exists only after a user gesture AND with sound switched on ---- */
  // MU3: the mixer, the SOUND panel and the music live in sound_system.js (ON by default, audio starts at the first click / tap / key). The old switch below only runs if that file did not load.
  const soundSys = (() => { try { return typeof soundMod.createSoundSystem === 'function' ? soundMod.createSoundSystem({
    page: 'battle', button: els.sound, input: () => input, enableDomNav, ownNav: true,
    onPanelOpen: () => { setPaused('sound', true); },
    onPanelClose: () => { setPaused('sound', false); setTimeout(() => { if (!controlsOpen) { try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } }, 0); },
  }) : null; } catch (e) { console.warn('[sound] the sound system could not start; the old switch is used:', e); return null; } })();
  const snd = { ctx: null, cry: new Map(), plays: 0 };
  function updateSoundButton() { if (soundSys) return; const on = cries.isSoundOn(); els.sound.textContent = 'Sound: ' + (on ? 'on' : 'off'); els.sound.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function ensureAudio() {
    if (soundSys || !cries.isSoundOn()) return null;
    if (!snd.ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; try { snd.ctx = new C(); } catch (_e) { return null; } }
    if (snd.ctx.state === 'suspended') { try { snd.ctx.resume(); } catch (_e) { /* ignore */ } }
    return snd.ctx;
  }
  const soundApi = {
    get: () => (soundSys ? soundSys.audible() : cries.isSoundOn()),
    open: soundSys ? (done) => soundSys.openPanel(done) : undefined,       // MU3: the pause menu's SOUND row opens the volume panel (scene.js menuActivate)
    set(on) { if (soundSys) { soundSys.setMuted(!on); return; } cries.setSoundOn(!!on); updateSoundButton(); if (on) ensureAudio(); else if (snd.ctx && snd.ctx.state === 'running') { try { snd.ctx.suspend(); } catch (_e) { /* ignore */ } } },
  };
  function playCryOf(species, mode) {
    if (soundSys) { soundSys.playCry(species, mode); return; }       // MU3: through the mixer's effects bus, only while audible
    if (!cries.isSoundOn() || !snd.ctx || snd.ctx.state !== 'running' || !packRef || !romBytes) return;
    try {
      let c = snd.cry.get(species);
      if (c === undefined) { c = cries.cryForSpecies(packRef, romBytes, species); snd.cry.set(species, c); }
      if (c && cries.playCry(snd.ctx, c, { mode, gain: 0.35 })) snd.plays++;
    } catch (_e) { /* a cry that cannot be decoded is simply silent */ }
  }
  updateSoundButton();
  if (!soundSys) els.sound.addEventListener('click', () => soundApi.set(!cries.isSoundOn()));
  const firstGesture = () => { if (cries.isSoundOn()) ensureAudio(); window.removeEventListener('pointerdown', firstGesture, true); window.removeEventListener('keydown', firstGesture, true); };
  window.addEventListener('pointerdown', firstGesture, true); window.addEventListener('keydown', firstGesture, true);
  // W1 fix D8: the header has the same Controls button as the hub and the editor (it opens the same dialog; the pause menu's CONTROLS row does too)
  if ($('controlsBtn')) $('controlsBtn').addEventListener('click', () => { if (!controlsOpen) openControls(null); });
  // W1 fix D2: the Menu button only OPENS the in-canvas pause menu; once it has, the keys must drive THAT menu, so focus goes back to the canvas (a button left focused
  // re-activated on every Enter, which closed the menu again and made CONTROLS unreachable from the keyboard). A mouse click, a tap and a keyboard activation all do it.
  els.menu.addEventListener('click', () => { if (scene) scene.press('start'); setTimeout(() => { if (!controlsOpen && !document.querySelector('[role="dialog"]:not([hidden])')) { try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } }, 0); });

  // W1 fix A4/A5: the move menu is the one battle screen with no VISIBLE way back (the party screen has CANCEL, the pause menu RESUME, a YES / NO its NO) and no visible way for a mouse
  // or a finger to read a move: two chips over the picture's top-right corner while it is open (B, and the move-info action, as the pad's B and X / the keys C do). They take no room.
  const chips = $('ctxchips');
  const chipPress = (a) => { if (scene && scene.mode === 'moves') { if (soundSys) soundSys.pressWithSfx(scene, a); else scene.press(a); } setTimeout(() => { if (!controlsOpen) { try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } }, 0); };
  if ($('chipBack')) $('chipBack').addEventListener('click', () => chipPress('b'));
  if ($('chipInfo')) $('chipInfo').addEventListener('click', () => chipPress('x'));
  function syncChips() {
    if (!chips || !scene) return;
    const want = scene.mode === 'moves' && !controlsOpen && document.body.dataset.state === 'ready';
    if (chips.hidden === want) chips.hidden = !want;
    if (want) {
      const w = $('screenWrap').getBoundingClientRect(), c = canvas.getBoundingClientRect();
      chips.style.left = Math.max(0, Math.round(c.right - w.left - chips.offsetWidth - 10)) + 'px'; chips.style.top = Math.round(c.top - w.top + 10) + 'px';
    }
  }

  /* ---- navigation after the result screen ---- */
  const navigate = (url) => { if (typeof window.__arenaNavigate === 'function') window.__arenaNavigate(url); else location.assign(url); };
  function rematchUrl(newSeed) {
    const u = new URL(location.href);
    u.searchParams.set('seed', String(newSeed >>> 0));
    return u.pathname + u.search;
  }
  // H1 integration: result buttons are REMATCH / EDIT TEAM / BACK TO HUB for a battle with a team, REMATCH / NEW BATTLE / BACK TO HUB for a quick one
  let online = null;                                  // the networked match (online.js), or null for a battle against the CPU
  const resultOptionsFor = () => (online ? ['REMATCH', 'BACK TO HUB'] : params.team !== null ? ['REMATCH', 'EDIT TEAM', 'BACK TO HUB'] : ['REMATCH', 'NEW BATTLE', 'BACK TO HUB']);
  // EDIT TEAM: find which saved team this battle was started with (the address carries only its code) and open the team builder on it
  async function editTeam() {
    let url = '/pokemonarena/editor.html';
    try {
      const [{ openStore }, data] = await Promise.all([import('./store.js'), import('./hub_data.js')]);
      const store = await openStore();
      const hit = await data.findTeamForCode(store, params.team);
      if (hit) { try { await store.setActiveId(hit.profileId); } catch (_e) { /* the editor falls back to the profile list */ } url = data.editorHref(hit.teamId); }
      try { await store.close(); } catch (_e) { /* ignore */ }
    } catch (_e) { /* the team builder opens on its profile list instead */ }
    navigate(url);
  }
  let resumeStore = null, resuming = false;          // D11: the saved-battle record (cleared when the result is chosen, the battle is left or it ends); resuming = the saved history is being replayed (silent)
  function onResult(choice) {
    if (online) { hook.resultChoice = choice; whenCareerSettled(() => online.onResult(choice)); return; }       // REMATCH asks the other player; BACK TO HUB leaves the room (after the battle has been written to the profile, at most 1.5 s)
    if (resumeStore) resumeStore.clear();
    hook.resultChoice = choice;
    whenCareerSettled(() => runResult(choice));
  }
  function runResult(choice) {
    if (choice === 'EDIT TEAM') editTeam();
    else if (choice === 'REMATCH') { const a = new Uint32Array(1); (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(a) : (a[0] = (hook.seed * 1103515245 + 12345) >>> 0); navigate(rematchUrl(a[0])); }
    else if (choice === 'NEW BATTLE') { const u = new URL(location.href); const keep = new URLSearchParams(); ['cpu', 'format'].forEach((k) => { if (u.searchParams.has(k)) keep.set(k, u.searchParams.get(k)); }); navigate(u.pathname + (keep.toString() ? '?' + keep.toString() : '')); }
    else navigate('/pokemonarena/');             // BACK TO HUB (and the old LEAVE)
  }

  /* ---- ST1: the career. When the RESULT screen appears the finished battle is written into the profile that fought it, ONCE (scene.js hooks.onMatchEnd fires once per page).
   * Which profile: the one that owns the team in the address (the same lookup EDIT TEAM uses), else the store's active profile (the Team Builder / the last team battle set it);
   * no profile at all -> nothing is written and the recap says so. The write is store.recordMatch: one transaction, idempotent by the match id (seed + format + CPU + the time
   * this page started), so a reload, a double fire or a second tab cannot count a battle twice; a FORFEIT is recorded as a forfeit, a draw as a draw; leaving mid-battle records nothing.
   * REMATCH / BACK TO HUB wait (at most 1.5 s) for a write that is still under way, so that leaving cannot cut it off.
   * A battle against a PERSON is kept the same way (schema 4: byCpu.online and an `opp` on the recent entry): `via` below names it. Its id is the seed, the format, the match number and the
   * room (career_stats.onlineMatchId), so a reload that replays the same match, or a second tab, cannot count it twice, while a rematch (a new seed and number) counts on its own. The profile
   * is the one that owns the team the player chose (the online panel records it), else the one that owns the team code, else the active profile.
   * A match that was STOPPED (a desync, a cheat, a malformed message, a refused team) writes nothing: before the engine has finished it the scene never reaches its result screen, and a match
   * the end-of-match comparison stopped AFTER the engine finished it is refused at onMatchEnd (nm.countable()): the error panel is up, the scene underneath only plays its last turn unseen.
   * The result is the engine's. Recorded as a FORFEIT: the player who forfeits (RUN, YES), whose own clock runs out with the page still open, or who comes back after a dead link that outlasted
   * the grace; the player who stayed wins and the win is kept. A player who leaves with BACK TO HUB, or closes the page, records NOTHING for themselves (the page is gone before the forfeit
   * has played through to the result screen); the opponent's win is still recorded. A win by the OPPONENT'S concession is a conceded win (career_stats.js: never a fastest win; a walkover is not a longest battle either). */
  const career = { state: 'idle', profileId: null, matchId: null, duplicate: false, callouts: [], error: null, why: null, promise: null };
  hook.career = career;
  let battleRuleset = DEFAULT_RULESET_ID;
  const startedAt = Date.now();
  function whenCareerSettled(fn) {
    if (career.promise && career.state === 'pending') { let done = false; const go = () => { if (!done) { done = true; fn(); } }; career.promise.then(go, go); setTimeout(go, 1500); } else fn();
  }
  function recordCareer(info, via) {
    career.state = 'pending';
    career.promise = (async () => {
      let store = null;
      try {
        const [{ openStore }, data] = await Promise.all([import('./store.js'), import('./hub_data.js')]);
        store = await openStore();
        let pid = null;
        if (via) {
          pid = via.profileId || null;
          if (!pid && via.teamCode) { const hit = await data.findTeamForCode(store, via.teamCode).catch(() => null); if (hit) pid = hit.profileId; }
        } else if (params.team !== null) { const hit = await data.findTeamForCode(store, params.team); if (hit) pid = hit.profileId; }
        if (!pid) pid = await store.getActiveId().catch(() => null);
        const loaded = pid ? await store.loadProfile(pid).catch(() => null) : null;
        if (!loaded || !loaded.ok || store.status.notSaved) { career.state = 'none'; scene.setCareer({ state: 'none' }); return; }
        if (loaded.readOnly) { career.state = 'none'; scene.setCareer({ state: 'none', notes: ['This profile was made by a newer', 'version of the Arena, so this battle', 'is not kept.'] }); return; }
        const id = via ? via.id : String(params.seed >>> 0) + '_' + params.format + '_' + params.cpu + '_' + startedAt.toString(36);
        const playMs = Math.max(0, Math.min(86400000, Math.round(info.ticks * 1000 / GBA_FPS)));
        const match = matchFromSummary(info.summary, via ? { id, at: Date.now(), fmt: via.fmt, cpu: 'online', opp: via.opp, ruleset: battleRuleset, playMs } : { id, at: Date.now(), fmt: params.format, cpu: params.cpu, ruleset: battleRuleset, playMs });
        career.profileId = pid; career.matchId = id;
        const r = await store.recordMatch(pid, match);
        career.duplicate = !!r.duplicate; career.callouts = r.callouts; career.rev = r.saved ? r.saved.rev : null;
        career.state = r.duplicate ? 'duplicate' : 'saved';
        scene.setCareer({ state: career.state, profileName: loaded.profile.trainerName, callouts: r.callouts, stats: r.saved ? r.saved.stats : r.before });
      } catch (e) {
        career.state = 'error'; career.error = String(e && e.message ? e.message : e).slice(0, 160);
        try { scene.setCareer({ state: 'error' }); } catch (_e) { /* the scene is gone */ }
      } finally { if (store) { try { await store.close(); } catch (_e) { /* ignore */ } } }
    })();
    return career.promise;
  }

  /* ---- load ---- */
  const parsed = parseBattleQuery(location.search);
  if (!parsed.ok) { showError({ title: parsed.error.title, message: parsed.error.message, detail: 'Parameter: ' + parsed.error.param, kind: 'params', param: parsed.error.param }); return; }
  const params = parsed.params;
  // An online address (?online=1 or the lobby's ?np=CODE&host=1|join=1) is a battle against a person: the seed is agreed with them, not drawn here.
  const onlineQuery = parseOnlineQuery(location.search);
  if (onlineQuery && onlineQuery.error) { showError({ title: 'That address cannot be used', message: onlineQuery.error, detail: 'Parameter: np / host / join', kind: 'params', param: 'np' }); return; }
  if (params.seed === null && !onlineQuery) {
    const a = new Uint32Array(1);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a); else a[0] = (Date.now() >>> 0);
    params.seed = a[0] >>> 0;
    try { const u = new URL(location.href); u.searchParams.set('seed', String(params.seed)); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (_e) { /* the seed is shown in the hook anyway */ }
  }
  hook.params = params; hook.seed = params.seed;

  const load = async () => {
    hook.state = 'boot'; els.err.hidden = true; els.boot.hidden = false; canvas.hidden = true; els.bar.value = 0;
    document.body.dataset.state = 'boot';
    els.bootText.textContent = 'Fetching the ROM from this site...';
    try {
      const loaded = await loadVerifiedRom({ onProgress: (got, total) => { els.bar.value = got / total; els.bootText.textContent = 'Loading ROM  ' + mbs(got) + ' / ' + mbs(total) + ' MB'; } });
      els.bar.value = 1; els.bootText.textContent = 'Checking the ROM and decoding its art...';
      await new Promise((r) => setTimeout(r, 0));
      return loaded;
    } catch (e) { showError(romError(e)); return null; }
  };

  async function start({ bytes, sha256 }) {
    let manifest = null;
    try { const r = await fetch('/pokemonarena/text_manifest.json'); if (r.ok) manifest = await r.json(); } catch (_e) { manifest = null; }
    let text;
    try {
      romBytes = bytes;
      packRef = loadPack(bytes, { verify: 'header', dexText: false });         // the SHA-256 was checked in loadVerifiedRom
      ui = createBattleUi(bytes);
      text = loadBattleText(bytes, manifest);
    } catch (e) { showError(romError(e)); return; }
    const r = onlineQuery ? { ok: true, spec: null } : await resolveBattle(packRef, params);       // online: the teams and the seed come from the handshake
    if (!r.ok) { showError({ title: r.error.title, message: r.error.message, detail: r.error.detail || '', kind: 'params', param: r.error.param }); return; }
    // AN1: animation settings (`arena.anim`, `?anim=` `?speed=1|2|4` `?animskip=`) and the shared ROM move animator (move_anim.js). The animator is built only while
    // animations are on; a module that is missing or throws leaves the battle on the old lunge + blink and says why in hook.animError.
    const animCfg = createAnimSettings({ storage: (() => { try { return window.localStorage; } catch (_e) { return null; } })(), search: location.search });
    hook.anim = animCfg; hook.animError = null; hook.animReady = false;
    let animTried = false;
    async function loadAnimator() {
      if (animTried) return null;
      animTried = true;
      try {
        const mod = await import('./move_anim.js');
        let coverage = null;
        try { const r = await fetch('/pokemonarena/js/anim_coverage.json'); if (r.ok) coverage = await r.json(); } catch (_e) { coverage = null; }       // per-id exact / approx / fallback (AN2); without it every id answers 'approx'
        const a = await mod.createMoveAnimator({ rom: bytes, coverage });
        hook.animReady = true;
        hook.prewarm = prewarmSystem(a);          // AN1 round 3: the first system run of a page visit is heavy; play a throwaway one now, behind the boot screen
        return a;
      } catch (e) { hook.animError = String(e && e.message ? e.message : e).slice(0, 160); return null; }
    }
    const animator = animCfg.get().on ? await loadAnimator() : null;
    let trainerPool = null; const trainerChoicesOf = () => trainerPool || (trainerPool = trainerChoices(bytes));          // AN1 round 4: the ROM trainers the CPU levels use for the foe picture (anim_sys.js)
    animCfg.onChange((c) => { if (c.on && !animTried) loadAnimator().then((a) => { if (a && scene) scene.setAnimator(a); }); });
    snd.events = []; snd.cries = [];
    // what every scene hears of the page: the Controls dialog, the cries and sounds (silent while a saved battle is replayed), plus the per-mode result / quit handling
    const mkHooks = (extra) => ({
      onControls: openControls,
      onSendOut: (side, sp) => { if (!resuming) playCryOf(sp, 'normal'); },
      onFaint: (side, sp) => { if (!resuming) playCryOf(sp, 'faint'); },
      onSound: (index, pan) => { if (!resuming && snd.events.length < 4096) snd.events.push([index, pan]); },
      onCry: (species, pan) => { if (!resuming) { if (snd.cries.length < 1024) snd.cries.push([species, pan]); playCryOf(species, 'normal'); } },
      ...extra,
    });
    // the first scene shows the screen: hide the boot panel, size the canvas, wire the input, publish the test hook and start the clock
    const showReady = () => {
      els.boot.hidden = true; els.err.hidden = true; canvas.hidden = false;
      document.body.dataset.state = 'ready';
      if (nav) { try { nav.disable(); } catch (_e) { /* ignore */ } }
      touchPad = coarse();
      fit();
      wireInput();
      hook.state = 'ready'; hook.kind = null; hook.error = null; hook.sha256 = sha256;
      makeHook();
      if (soundSys) { soundSys.setRom({ bytes, pack: packRef }); window.__arenaSound = soundSys; }       // MU3: the ROM's music; nothing is heard before the first click / tap / key
      try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
      runLoop();
    };

    /* ---- ONLINE: a battle against a person. The scene is built when the handshake has produced the controller (and again for each rematch). ---- */
    if (onlineQuery) {
      let shown = false;
      const mountOnlineScene = (c, info) => {
        ctl = c; battleRuleset = c.netMeta.ruleset;
        hook.seed = info.seed; hook.params.seed = info.seed;
        // a RELOADED battle: its history is already in the controller, and the scene plays it silently and at speed (the same replay the CPU battle's reload uses), then goes on live
        resuming = !!info.resumed;
        scene = createScene({
          ui, pack: packRef, text, ctl: c, viewSide: info.mySide, resultOptions: resultOptionsFor(), env: info.seed % 9, textSpeed: params.speed, meta: c.netMeta.meta,
          trainer: info.oppName, playerName: 'You', trainerChoices: trainerChoicesOf(), cpuLevel: 'normal', clock: () => performance.now(), sound: soundApi, quitLabel: 'BACK TO HUB',
          anim: animCfg, animator: resuming ? null : animator, animSeed: info.seed,
          hooks: mkHooks({
            onResult: onResult,
            onMatchEnd: (mi) => {
              // kept in the trainer's profile like any other battle (recordCareer); `online.state` says which profile and which team, `info` which match
              const st = online ? online.state : {};
              // a match that was STOPPED after the engine finished it (the end-of-match comparison found the other machine ended in another position) is not counted:
              // the error panel is already up and the scene underneath only reached its result screen unseen. scene.setCareer is NOT called: the scene's own record state stays 'pending'
              // behind the hidden battle canvas (its only reader is the recap page drawn on that canvas), and the online page test pins that the canvas is hidden (F22) and that nothing was written (F23)
              if (st.nm && typeof st.nm.countable === 'function' && !st.nm.countable()) { career.state = 'none'; career.why = 'match-stopped'; return; }
              recordCareer(mi, { id: onlineMatchId({ seed: info.seed, fmt: info.fmt, mn: info.mn, room: info.room }), fmt: info.fmt, opp: cleanName(info.oppName, 'Player'), profileId: st.profileId || null, teamCode: st.myTeamCode || null });
            },
            onQuit: () => online.leaveToHub(),
          }),
        });
        scene.begin();
        if (resuming) { hook.resume = { restored: true, online: true, frames: scene.catchUp() }; resuming = false; scene.setAnimator(animator); }
        if (soundSys) soundSys.hookScene(scene);
        if (scene.mode === 'steps') scene.tick();
        hook.online = online;
        if (!shown) { shown = true; showReady(); hook.mountCount = 1; }
        else { hook.mountCount++; Object.assign(hook, { scene, ctl }); lastSig = ''; draw(true); }
      };
      try {
        els.boot.hidden = true; document.body.dataset.state = 'online'; hook.state = 'online';
        online = createOnline({
          win: window, doc: document, pack: packRef, root: $('screenWrap'), bar: $('note'), query: onlineQuery, teamParam: params.team,
          formatParam: new URLSearchParams(location.search).get('format'), fingerprint: engineFingerprint(packRef),
          hooks: {
            stage: (s) => { hook.onlineStage = s; },
            mountScene: mountOnlineScene,
            sceneState: () => ({ mode: scene ? scene.mode : null, pending: !!(ctl && online && online.state.info && ctl.pending(online.state.info.mySide)) }),
            showFatal: ({ title, message }) => { canvas.hidden = true; showError({ title, message, kind: 'online' }); },
            toHub: () => navigate('/pokemonarena/'),
          },
        });
        window.__arenaOnline = online;
        await online.begin();
      } catch (e) { showError({ title: 'Online play could not start', message: String(e && e.message ? e.message : e), kind: 'internal' }); }
      return;
    }
    try {
      const spec = r.spec;
      battleRuleset = spec.ruleset;
      const makeCtl = () => createMatchController({ pack: packRef, ruleset: spec.ruleset, teams: spec.teams, seed: spec.seed, pick: spec.pick, names: spec.names, sides: spec.sides });
      ctl = makeCtl(); ctl.start();
      // D11: a RELOAD (or a back / forward step) of a battle that was under way replays the human's saved choices into the controller, proves the result is the saved state, and lets
      // the scene play the history at speed and silently; anything doubtful starts the battle from the team preview as before (hook.resume.reason says why). A fresh visit never resumes.
      let store = null; try { store = window.sessionStorage; } catch (_e) { store = null; }
      resumeStore = createResumeStore({ storage: store, key: resumeKey(location.pathname, location.search), seed: spec.seed });
      const rs = resumeStore.restore({ ctl, makeCtl, navType: navigationType() });
      ctl = rs.ctl; hook.resume = rs.info; resuming = rs.info.restored;
      scene = createScene({ ui, pack: packRef, text, ctl, viewSide: 0, resultOptions: resultOptionsFor(), env: spec.seed % 9, textSpeed: params.speed, meta: spec.meta, trainer: spec.trainer, playerName: 'You', trainerChoices: trainerChoicesOf(), cpuLevel: spec.cpu, clock: () => performance.now(), sound: soundApi, quitLabel: 'BACK TO HUB', anim: animCfg, animator: resuming ? null : animator, animSeed: spec.seed, hooks: mkHooks({ onResult: onResult, onMatchEnd: recordCareer, onQuit: () => { if (resumeStore) resumeStore.clear(); whenCareerSettled(() => navigate('/pokemonarena/')); } }) });
      scene.begin();
      if (resuming) { hook.resume.frames = scene.catchUp(); resuming = false; scene.setAnimator(animator); }
      if (soundSys) soundSys.hookScene(scene);       // MU3: hit / faint / send-out sounds and the animator's sound events -> the ROM's effects (hooked after a resume's silent replay)
      resumeStore.attach(ctl);
      if (scene.mode === 'steps') scene.tick();       // AN1 round 4: begin() leaves the scene ONE tick short of its first screen (the team preview). Settle it before 'ready', so the first frame drawn and the first key pressed land on the preview (measured, desktop 1280x800: a key sent at ready was lost on 5 of 5 loads with animations on, 1 of 5 with them off)
    } catch (e) { showError({ title: 'The battle could not start', message: String(e && e.message ? e.message : e), detail: Array.isArray(e && e.detail) ? e.detail.slice(0, 3).map((x) => x.message || x.code).join('; ') : '', kind: 'internal' }); return; }

    showReady();
    // OPEN TO BATTLES (presence_boot.js): mounted in EVERY battle against the CPU. While the switch is on, a challenge reaches the player here too, in the middle of this battle: the dialog pauses the battle
    // like the Controls panel does, and Accept leaves this battle (a battle left unfinished is recorded as nothing) for the challenger's. While the switch is OFF the mount is dormant (no board connection,
    // no dialog in the page): it keeps the header's Open button (the way to switch it on or off from here) and follows the switch going on in another tab.
    // The button is un-hidden now only to hold its room (battle.css keeps it invisible until the module has mounted and wired it), so the header does not move when it appears.
    const openBtn = $('openBtn');
    if (openBtn) openBtn.hidden = false;
    import('./presence_boot.js').then((m) => {
      hook.presence = m.mountPresence({
        win: window, doc: document, pack: packRef, input, enableDomNav, navigate, button: openBtn, buttonText: false,
        focusHome: () => { if (!controlsOpen) { try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } },
        onDialog: { open: (which) => { setPaused('presence:' + which, true); }, close: (which) => { setPaused('presence:' + which, false); setTimeout(() => { if (!controlsOpen) { try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } }, 0); } },
      });
    }).catch((e) => { if (window.console) console.warn('[presence] not available', e); if (openBtn) openBtn.hidden = true; });
  }

  /* ---- input ---- */
  function wireInput() {
    hook.input = input;
    // W1 fix A4: the on-screen pad is shown from the FIRST TOUCH on any touch screen (a laptop or desktop touch monitor reports a fine pointer, so the media query at start said no);
    // registered before the hint line so that the line already describes the pad that is about to appear
    // (and a MOUSE that starts moving on a touch screen takes the pad away again: a hover:none laptop or tablet with a mouse attached)
    // The pad is laid out AFTER the gesture that asked for it, never under it: re-fitting at pointer-down moved the picture under the finger, so a first tap after a device switch missed
    // (journey S, "a tap on RUN"). The state changes at once (the hint line speaks of it), the layout follows 450 ms later.
    let padTimer = null;
    const padTo = (on) => { touchPad = on; clearTimeout(padTimer); padTimer = setTimeout(() => { padTimer = null; fit(); }, 450); };
    input.on('source', (e) => { if (e.source === 'touch' && !touchPad) padTo(true); else if (e.source === 'mouse' && touchPad) padTo(false); });
    if ($('keys')) watchHints(input, $('keys'), { menu: true, battle: true, pad: () => touchPad });         // the hint line speaks of the device the player last used
    const toLocal = input.mapClientToLogical(canvas, SCREEN_W, SCREEN_H);
    input.registerPointerTarget(canvas, { toLocal, cursor: { actionable: (x, y) => { const h = scene.hit(x, y); return !!h && h.kind !== 'text'; } } });
    for (const b of document.querySelectorAll('[data-btn]')) input.bindPad(b, b.dataset.btn);
    input.on('action', (e) => {
      if (controlsOpen) return;
      scene.hold(input.isDown('a'), input.isDown('b'));
      if (!e.pressed || e.native) return;
      // Esc is B everywhere, except at the top action menu where B has nothing to go back to: there it opens the pause menu (RESUME / CONTROLS / SOUND / FORFEIT / BACK TO HUB)
      if (e.code === 'Escape' && e.source === 'keyboard' && (scene.mode === 'action' || scene.mode === 'wait')) { scene.press('start'); return; }
      if (soundSys) soundSys.pressWithSfx(scene, e.action); else scene.press(e.action);
    });
    input.on('pointer', (e) => {
      if (controlsOpen) return;
      if (e.kind === 'wheel') { if (e.el === canvas || e.x === null) scene.pointer({ kind: 'wheel', steps: e.steps }); return; }
      if (e.el !== canvas || !e.inside) return;
      if (e.kind === 'move' || (e.kind === 'down' && e.source === 'touch')) scene.pointer({ kind: 'move', x: e.x, y: e.y });
      else if (e.kind === 'click') { if (soundSys) soundSys.clickWithSfx(scene, { kind: 'click', x: e.x, y: e.y }); else scene.pointer({ kind: 'click', x: e.x, y: e.y }); }
    });
  }

  /* ---- the clock: a fixed 59.7275 Hz step regardless of the display rate ---- */
  const img = new ImageData(SCREEN_W, SCREEN_H);
  let lastSig = '', renders = 0;
  function draw(force) {
    const v = scene.view();
    const sig = JSON.stringify(v);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const f = ui.render(v);
    img.data.set(f.rgba); ctx.putImageData(img, 0, 0); renders++;
  }
  function runLoop() {
    last = performance.now(); let acc = 0;
    const loop = (now) => {
      const dt = Math.min(250, now - last); last = now;
      if (!document.hidden && !hook.paused && !controlsOpen) {
        acc += dt;
        let n = 0;
        while (acc >= STEP_MS && n < 8) { scene.tick(); acc -= STEP_MS; n++; }
        if (n >= 8) acc = 0;
        scene.hold(input.isDown('a'), input.isDown('b'));
      }
      draw(false); syncChips();
      if (soundSys) soundSys.battleFrame(scene, params.cpu, params.format !== '6v6');       // MU3: team preview / battle / result music follows the scene's mode; the pause menu ducks it
      requestAnimationFrame(loop);
    };
    draw(true);
    requestAnimationFrame(loop);
  }

  /* ---- the test hook ---- */
  function makeHook() {
    const fnv = (u8) => { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); };
    Object.assign(hook, {
      scene, ctl, ui, pack: packRef, canvas, scale: hook.scale,
      getState: () => scene.state(),
      press: (a) => scene.press(a), hold: (a, b) => scene.hold(a, b),
      view: () => scene.view(),
      events: () => ctl.battle.events.slice(),
      hash: () => ctl.battle.hash(), logHash: () => ctl.battle.logHash(),
      frameHash: () => { const f = ui.render(scene.view()); return fnv(f.rgba); },
      canvasHash: () => fnv(ctx.getImageData(0, 0, SCREEN_W, SCREEN_H).data),
      tick: (n = 1) => { for (let i = 0; i < n; i++) scene.tick(); draw(true); return scene.state(); },
      settle: (max) => { const n = scene.settle(max); draw(true); return n; },
      // let a CPU play the human's seat to the end (the page's own spectator / smoke path). Returns { frames, winner, turns, hash }.
      autoplay: (maxFrames = 600000, level = 'normal') => {
        const ai = createAi({ pack: packRef, level, seed: params.seed ^ 0x5bd1e995 });
        scene.S.auto = { ai, decide(req) { return ai.choose(req, ctl.view(0), { previewInfo: { foe: ctl.previewInfo[1] } }); } };
        let n = 0;
        while (n++ < maxFrames && scene.mode !== 'result') { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); }
        draw(true);
        return { frames: n, winner: ctl.winner, turns: ctl.turn, hash: ctl.battle.hash(), mode: scene.mode };
      },
      pause: (v) => { hook.paused = !!v; },
      animInfo: () => scene.animInfo(), soundEvents: () => snd.events.slice(), cryEvents: () => snd.cries.slice(),
      openControls, closeControls: () => ctlDlg.close(), controlsDialog: ctlDlg,
      resultOptions: resultOptionsFor(),
    });
    Object.defineProperty(hook, 'mode', { get: () => scene.mode, configurable: true });
    Object.defineProperty(hook, 'renders', { get: () => renders, configurable: true });
    hook.sound = { on: () => (soundSys ? soundSys.audible() : cries.isSoundOn()) };
    Object.defineProperty(hook.sound, 'plays', { get: () => (soundSys ? soundSys.plays : snd.plays) });
    Object.defineProperty(hook.sound, 'ctx', { get: () => (soundSys ? soundSys.ctx() : snd.ctx) });
  }

  let loaded = await load();
  els.retry.addEventListener('click', async () => { loaded = await load(); if (loaded) await start(loaded); });
  if (!loaded) return;
  await start(loaded);
}

if (hasDom) {
  main().catch((e) => {
    const err = document.getElementById('error');
    if (err) { err.hidden = false; document.getElementById('errTitle').textContent = 'Something went wrong'; document.getElementById('errMsg').textContent = String(e && e.message ? e.message : e); const b = document.getElementById('boot'); if (b) b.hidden = true; }
    if (window.__arenaBattle) { window.__arenaBattle.state = 'error'; window.__arenaBattle.kind = 'internal'; window.__arenaBattle.error = String(e && e.message ? e.message : e); }
    console.error(e);
  });
}
