// pokemonarena/js/hub_model.js -- the HUB's state machine: which menu is open, where the cursor is, what each press does.
//
// Pure ES module (browser + Node 24): no DOM, no ROM, no timers, no randomness, no storage, no clock. A scripted run of presses and
// ticks therefore gives identical views, which tools/pokemonarena_hub_test.mjs relies on. hub_screen.js turns a view into pixels from the
// ROM; boot.js owns everything with a side effect (navigation, sound, storage, the controls dialog) and carries out the EFFECTS this
// module returns.
//
//   const hub = createHubModel({ sound: false, mascot: 25 });
//   hub.press('down');                 // -> []                      (effects to carry out)
//   hub.press('a');                    // -> [{ type: 'screen', path: 'quick' }]  (a screen change; the page mirrors it into the address bar)
//   hub.view()                         // -> a plain JSON description hub_screen.js draws
//
// SCREENS   main    QUICK BATTLE / BATTLE WITH MY TEAM / RECORD / TEAM BUILDER / IMPORT SAVE / CONTROLS / SOUND / ABOUT
//           quick   FORMAT, CPU, START, BACK            (random teams against the CPU)
//           team    [PROFILE], TEAM, FORMAT, CPU, START, BACK   (one of the player's saved teams against a random CPU team)
//           record  the trainer's battle record, in pages (record_model.js); left / right turn the page, up / down switch trainer (several profiles) or turn it (one),
//                   A turns it, on the last page RESET RECORD asks YES / NO; B goes back
//           about   pages of text (what is from the ROM, what is approximate)
// INPUT     one vocabulary for every device: the twelve actions of input.js (up down left right a b x y l r start select) and, for
//           canvas pointers, hit(x, y) / pointer({ kind: 'move' | 'click' | 'wheel' }). Mouse, touch, keyboard and controller therefore
//           reach exactly the same states.
// EFFECTS   { type: 'screen', path }        the screen changed (mirror it into history)
//           { type: 'navigate', url }       leave for another page (the team builder; IMPORT SAVE opens its save-import screen)
//           { type: 'sound', on }           the SOUND row was toggled (persist it, play a cry)
//           { type: 'controls' }            open the Controls panel (a DOM dialog)
//           { type: 'battle', mode: 'quick' | 'team', format, cpu, profileId?, teamId? }   START was chosen
//           { type: 'blocked', reason }     START refused (a message is also shown in the text box)
//           { type: 'record-reset', profileId }   RESET RECORD was answered YES (the page empties that profile's record in the store and reloads the list)

import { buildRecordNotice, buildResetConfirm } from './record_model.js';

export const SCREEN_W = 240, SCREEN_H = 160;
export const FORMATS = Object.freeze(['3v3', '6v6']);
export const CPU_LEVELS = Object.freeze(['easy', 'normal', 'hard']);
export const BUILDER_URL = '/pokemonarena/editor.html';
export const IMPORT_URL = '/pokemonarena/editor.html#/import';
export const PATHS = Object.freeze(['main', 'quick', 'team', 'record', 'about']);

// geometry shared with the renderer and with hit testing (logical 240x160 pixels)
export const GEOM = Object.freeze({
  menu: Object.freeze({ x: 12, y: 10, w: 124, pitch: 16, pitchTight: 14, pitchEight: 12 }),
  title: Object.freeze({ x: 148, y: 84, w: 84, h: 16 }),
  mascot: Object.freeze({ cx: 186, cy: 38 }),
  about: Object.freeze({ x: 12, y: 12, w: 216, h: 92, pitch: 13 }),
  // ST1: the RECORD screen: a title line (the trainer on the left, the page's name and number on the right), one ROM window for the page (PAGE_W x PAGE_H of recap_model.js) and three buttons under it
  record: Object.freeze({ title: Object.freeze({ x: 8, y: -2 }), trainer: Object.freeze({ x: 4, y: 0, w: 108, h: 16 }), win: Object.freeze({ x: 10, y: 20, w: 220, h: 106 }),
    chips: Object.freeze([Object.freeze({ id: 'prev', x: 10, y: 140, w: 64, h: 16 }), Object.freeze({ id: 'back', x: 88, y: 140, w: 64, h: 16 }), Object.freeze({ id: 'next', x: 166, y: 140, w: 64, h: 16 })]) }),
});

/** Row spacing of a menu of n rows: seven rows do not fit above the text box at the normal 16 px, so they sit 14 px apart; the eight rows of the main menu (RECORD joined it) sit 12 px apart. */
export function menuPitch(n) { return n > 7 ? GEOM.menu.pitchEight : n > 6 ? GEOM.menu.pitchTight : GEOM.menu.pitch; }

const MAIN_ITEMS = Object.freeze([
  { id: 'quick', label: 'QUICK BATTLE', help: ['Random teams against the CPU.', 'Pick 3v3 or 6v6 and the CPU level.'] },
  { id: 'team', label: 'BATTLE WITH MY TEAM', help: ['Fight with a team you built.', 'Make one in the TEAM BUILDER first.'] },
  { id: 'record', label: 'RECORD', help: ['Wins, streaks, best hits, favourites', 'and your last battles, by trainer.'] },
  { id: 'builder', label: 'TEAM BUILDER', help: ['Make a profile and build teams:', 'natures, EVs, IVs, items, moves.'] },
  { id: 'import', label: 'IMPORT SAVE', help: ['Bring Pokemon from your own', 'SoulGold save file. It stays here.'] },
  { id: 'controls', label: 'CONTROLS', help: ['Mouse, keyboard, controller and', 'touch all work. Change the keys here.'] },
  { id: 'sound', label: 'SOUND', help: ['Volume, music, effects, soundtrack.', 'The M key mutes on any page.'] },
  { id: 'about', label: 'ABOUT', help: ['What comes from the ROM and what', 'is only an approximation.'] },
]);
export const MAIN_LABELS = Object.freeze(MAIN_ITEMS.map((i) => i.label));

// The ABOUT pages: plain statements, written to be true of this build (README.md carries the long version).
export const ABOUT_PAGES = Object.freeze([
  ['POK{E}MON ARENA', 'A Gen 3 style battle game. Fight a CPU with', 'random teams, or with teams you build.', 'It all runs in this browser. Nothing you', 'make is uploaded anywhere.'],
  ['FROM THE ROM', 'Every picture, font, window, menu and cry', 'is read from the Pokemon SoulGold v1.1.1', 'ROM this site already serves, in your', 'browser. Battle messages use the ROM text;', 'a few menu words are written by this site.'],
  ['APPROXIMATE', 'The battle engine is this site\'s own, built', 'on the ROM data. Moves play the game\'s own', 'animations. Mega, Z-moves, Dynamax and Tera', 'are not here; a few species and abilities', 'are refused with a reason. Damage is modern.'],
  ['NOT HERE', 'Doubles battles and online play are not', 'available. Your profile, teams and battle', 'record stay in this browser only: use Export', 'in the TEAM BUILDER to keep a copy. Clearing', 'the site data in your browser erases them.'],
]);

// what each CPU level does (ai.js header): easy = a random legal move; normal = best expected damage plus some tactics; hard = normal plus a
// one-turn lookahead over its own options and the foe's likely replies
const CPU_HELP = Object.freeze({ easy: 'EASY: the CPU picks random moves.', normal: 'NORMAL: best damage, some tactics.', hard: 'HARD: it also looks one turn ahead.' });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cycle = (list, cur, dir) => list[(list.indexOf(cur) + dir + list.length) % list.length];
const hasOwn = Object.prototype.hasOwnProperty;

/** The formats a team of this size may play (a 3v3 battle needs three Pokemon; battle.html refuses fewer). */
export function allowedFormats(size) { return size >= 3 ? ['3v3', '6v6'] : ['6v6']; }
/** The format a team of this size starts on. */
export function defaultFormat(size) { return size >= 4 ? '6v6' : size === 3 ? '3v3' : '6v6'; }

/**
 * opts: { sound: bool, mascot: species id, env: terrain id, quick: { format, cpu }, selection: { profileId, teamId, cpu },
 *         pickMascot: (view-model) -> species id (default keeps the opts.mascot) }
 */
export function createHubModel(opts = {}) {
  const S = {
    path: 'main', cursor: { main: 0, quick: 0, team: 0 }, from: 'main',
    sound: !!opts.sound, mascot: Number.isInteger(opts.mascot) ? opts.mascot : 25, env: Number.isInteger(opts.env) ? opts.env : 0,
    quick: { format: opts.quick && FORMATS.includes(opts.quick.format) ? opts.quick.format : '3v3', cpu: opts.quick && CPU_LEVELS.includes(opts.quick.cpu) ? opts.quick.cpu : 'normal' },
    team: { profileId: opts.selection && opts.selection.profileId || null, teamId: opts.selection && opts.selection.teamId || null, format: null, formatTouched: false, cpu: opts.selection && CPU_LEVELS.includes(opts.selection.cpu) ? opts.selection.cpu : 'normal' },
    data: { state: 'loading', profiles: [], note: '', activeId: null },       // state: loading | ready | unavailable
    about: { page: 0 }, flash: null, tick: 0, resultsOf: null,
    record: { page: 0, profileId: null, focus: 'page', confirm: null, hover: null },
  };

  /* ------------------------------------------------------------------------------------------ team data */
  const profiles = () => S.data.profiles;
  const curProfile = () => { const ps = profiles(); return ps.find((p) => p.id === S.team.profileId) || ps[0] || null; };
  const curTeam = () => { const p = curProfile(); if (!p) return null; return p.teams.find((t) => t.id === S.team.teamId) || p.teams[0] || null; };
  // a profile's record pages as the store reader built them (hub_data.js): plain JSON, kept as given when it has the right shape
  function recordOf(p) {
    const r = p && p.record;
    if (!r || !Array.isArray(r.pages) || !r.pages.length || r.pages.length > 64) return null;
    return { battles: r.battles | 0, resettable: !!r.resettable, pages: JSON.parse(JSON.stringify(r.pages)) };
  }
  function normaliseTeamSel() {
    const p = curProfile(); S.team.profileId = p ? p.id : null;
    const t = curTeam(); S.team.teamId = t ? t.id : null;
    const ok = t ? allowedFormats(t.size) : FORMATS;
    if (!S.team.formatTouched || !ok.includes(S.team.format)) { S.team.format = t ? defaultFormat(t.size) : '3v3'; S.team.formatTouched = false; }
  }

  /* ------------------------------------------------------------------------------------------ the rows of each screen */
  function mainRows() {
    return MAIN_ITEMS.map((it) => ({ id: it.id, kind: 'item', label: it.label === 'SOUND' ? 'SOUND: ' + (S.sound ? 'ON' : 'OFF') : it.label }));
  }
  function quickRows() {
    return [
      { id: 'format', kind: 'choice', label: 'FORMAT', value: S.quick.format, values: FORMATS },
      { id: 'cpu', kind: 'choice', label: 'CPU', value: S.quick.cpu.toUpperCase(), values: CPU_LEVELS },
      { id: 'start', kind: 'button', label: 'START' },
      { id: 'back', kind: 'button', label: 'BACK' },
    ];
  }
  function teamRows() {
    const rows = [];
    const ps = profiles(), t = curTeam(), p = curProfile();
    if (!t) { rows.push({ id: 'builder', kind: 'button', label: 'TEAM BUILDER' }, { id: 'back', kind: 'button', label: 'BACK' }); return rows; }
    if (ps.length > 1) rows.push({ id: 'profile', kind: 'choice', label: 'TRAINER', value: p.name, values: ps.map((x) => x.id) });
    rows.push({ id: 'teamsel', kind: 'choice', label: 'TEAM', value: t.name, values: p.teams.map((x) => x.id), count: p.teams.length });
    rows.push({ id: 'format', kind: 'choice', label: 'FORMAT', value: S.team.format, values: allowedFormats(t.size) });
    rows.push({ id: 'cpu', kind: 'choice', label: 'CPU', value: S.team.cpu.toUpperCase(), values: CPU_LEVELS });
    rows.push({ id: 'start', kind: 'button', label: 'START', disabled: !t.legal });
    rows.push({ id: 'back', kind: 'button', label: 'BACK' });
    return rows;
  }
  function rowsOf(path) { return path === 'main' ? mainRows() : path === 'quick' ? quickRows() : path === 'team' ? teamRows() : []; }
  const rows = () => rowsOf(S.path);
  function clampCursor() { const n = rows().length; if (n) S.cursor[S.path] = clamp(S.cursor[S.path], 0, n - 1); }

  /* ------------------------------------------------------------------------------------------ text box help */
  function helpFor(row) {
    if (S.flash) return S.flash;
    if (S.path === 'main') {
      if (row.id === 'sound') return S.sound ? ['A opens the SOUND panel: volume,', 'music, effects and soundtrack.'] : ['Sound is muted. The SOUND panel', 'unmutes it and sets the volume.'];
      const it = MAIN_ITEMS.find((x) => x.id === row.id); return it ? it.help : ['', ''];
    }
    if (S.path === 'quick') {
      if (row.id === 'format') return S.quick.format === '3v3' ? ['3v3: pick 3 of 6 at a team preview.', 'A or the arrows change it.'] : ['6v6: all six Pokemon fight.', 'A or the arrows change it.'];
      if (row.id === 'cpu') return [CPU_HELP[S.quick.cpu], 'A or the arrows change it.'];
      if (row.id === 'start') return ['Both teams are random and legal.', 'A starts the battle.'];
      return ['Back to the main menu.', ''];
    }
    if (S.path === 'team') {
      if (S.data.state === 'loading') return ['Looking for your teams...', ''];
      const t = curTeam(), p = curProfile();
      if (!t) return S.data.state === 'unavailable' ? ['Your teams could not be read here.', S.data.note || 'Storage may be blocked.'] : [p ? 'This trainer has no team yet.' : 'You have no team yet.', 'Build one in the TEAM BUILDER.'];
      if (row.id === 'teamsel' || row.id === 'profile') return [t.names.slice(0, 3).join(', ') || '(empty)', t.names.length > 3 ? t.names.slice(3).join(', ') : (t.legal ? 'Legal and ready to fight.' : 'Not ready: ' + t.problems + ' problem' + (t.problems === 1 ? '' : 's') + '.')];
      if (row.id === 'format') return [S.team.format === '3v3' ? '3v3: pick 3 of your ' + t.size + ' at a preview.' : '6v6: all ' + t.size + ' of your Pokemon fight.', t.size < 3 ? 'A team under 3 plays 6v6 only.' : 'A or the arrows change it.'];
      if (row.id === 'cpu') return [CPU_HELP[S.team.cpu], 'The CPU brings a random legal team.'];
      if (row.id === 'start') return t.legal ? ['Fight with ' + t.name + '.', 'A starts the battle.'] : ['Fix ' + t.problems + ' problem' + (t.problems === 1 ? '' : 's') + ' in the TEAM BUILDER', 'first, then come back.'];
      return ['Back to the main menu.', ''];
    }
    return ['', ''];
  }

  /* ------------------------------------------------------------------------------------------ view */
  function mascotNow() {
    if (S.path === 'team') { const t = curTeam(); if (t && t.lead) return { species: t.lead.species, shiny: !!t.lead.shiny, gender: t.lead.gender || null }; }
    return { species: S.mascot, shiny: false, gender: null };
  }
  /* ------------------------------------------------------------------------------------------ the RECORD screen (ST1) */
  // the trainer shown: the one chosen here, else the active profile of the store, else the one last used for a team battle, else the first
  const curRecordProfile = () => { const ps = profiles(); return ps.find((p) => p.id === S.record.profileId) || ps.find((p) => p.id === S.data.activeId) || ps.find((p) => p.id === S.team.profileId) || ps[0] || null; };
  function recordPages() {
    if (S.data.state === 'loading') return buildRecordNotice('loading');
    if (S.data.state === 'unavailable') return buildRecordNotice('unavailable');
    const p = curRecordProfile();
    if (!p) return buildRecordNotice('none');
    return p.record && p.record.pages.length ? p.record.pages : buildRecordNotice('unavailable');
  }
  const recordPageNow = (pages) => pages[clamp(S.record.page, 0, pages.length - 1)];
  const recordButtonRect = (pg) => (pg && pg.button ? { x: GEOM.record.win.x + pg.button.x, y: GEOM.record.win.y + pg.button.y, w: pg.button.w, h: pg.button.h } : null);
  function recordTurn(d) { const pages = recordPages(); S.record.page = clamp(S.record.page + d, 0, pages.length - 1); }
  function recordTrainer(d) {
    const ps = profiles(); if (ps.length < 2) return;
    const cur = curRecordProfile();
    S.record.profileId = ps[(ps.findIndex((p) => p.id === cur.id) + d + ps.length) % ps.length].id; S.record.page = 0; S.record.confirm = null;
  }
  function recordOpenConfirm() { const p = curRecordProfile(), pg = recordPageNow(recordPages()); if (!p || !pg || !pg.button || !pg.button.enabled) return; S.record.confirm = { cursor: 1, profileId: p.id, name: p.name }; }
  function recordView() {
    const p = curRecordProfile(), c = S.record.confirm;
    const pages = c ? [buildResetConfirm(c.name)] : recordPages();
    const index = c ? 0 : clamp(S.record.page, 0, pages.length - 1), pg = pages[index], br = !c ? recordButtonRect(pg) : null;
    return { screen: 'record', env: S.env, mascot: mascotNow(), tick: S.tick, sound: S.sound, title: false, about: null, menu: null, msg: null,
      record: { page: pg, index, count: pages.length, trainer: p ? { name: p.name, index: profiles().indexOf(p), count: profiles().length } : null, focus: S.record.focus, confirm: c ? { cursor: c.cursor } : null,
        hover: S.record.hover, canPrev: !c && index > 0, canNext: !c && index < pages.length - 1, button: br ? { label: pg.button.label, enabled: pg.button.enabled, x: br.x, y: br.y, w: br.w, h: br.h } : null, notice: pg.id === 'notice' } };
  }
  function recordPress(a) {
    const c = S.record.confirm;
    if (c) {
      if (a === 'left' || a === 'right' || a === 'up' || a === 'down') c.cursor ^= 1;
      else if (a === 'a') { S.record.confirm = null; if (c.cursor === 0) { S.record.page = 0; return [{ type: 'record-reset', profileId: c.profileId }]; } }
      else if (a === 'b') S.record.confirm = null;
      return [];
    }
    const pages = recordPages(), pg = recordPageNow(pages), multi = profiles().length > 1;
    if (a === 'b') return back();
    if (a === 'up' || a === 'down') { if (multi) S.record.focus = a === 'up' ? 'trainer' : 'page'; else recordTurn(a === 'up' ? -1 : 1); return []; }
    if (a === 'left' || a === 'l' || a === 'right' || a === 'r') { const d = a === 'left' || a === 'l' ? -1 : 1; if (S.record.focus === 'trainer' && multi) recordTrainer(d); else recordTurn(d); return []; }
    if (a === 'a') {
      if (pg.action === 'builder') return [{ type: 'navigate', url: BUILDER_URL }];
      if (S.record.focus === 'trainer' && multi) { recordTrainer(1); return []; }
      if (pg.button) { recordOpenConfirm(); return []; }
      if (S.record.page < pages.length - 1) { recordTurn(1); return []; }
      return back();
    }
    return [];
  }
  function recordHit(x, y) {
    const G = GEOM.record, inR = (r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    if (S.record.confirm) { if (inR({ x: G.chips[0].x - 2, y: G.chips[0].y - 4, w: G.chips[0].w + 4, h: G.chips[0].h + 8 })) return { kind: 'rec-yes' }; return { kind: 'rec-no' }; }
    if (profiles().length > 1 && inR(G.trainer)) return { kind: x < G.trainer.x + G.trainer.w / 2 ? 'rec-trainer-prev' : 'rec-trainer-next' };
    for (const c of G.chips) if (inR({ x: c.x - 2, y: c.y - 4, w: c.w + 4, h: c.h + 8 })) return { kind: 'rec-' + c.id };
    const b = recordButtonRect(recordPageNow(recordPages()));
    if (b && inR({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 })) return { kind: 'rec-reset' };
    return inR({ x: 0, y: 14, w: 240, h: 124 }) ? { kind: 'rec-page' } : null;
  }
  function recordPointer(ev) {
    if (ev.kind === 'wheel') { const n = Math.abs(ev.steps || 0); for (let i = 0; i < n; i++) { if (S.record.confirm) recordPress((ev.steps || 0) > 0 ? 'down' : 'up'); else recordTurn((ev.steps || 0) > 0 ? 1 : -1); } return []; }
    const h = ev.x === undefined || ev.x === null ? null : recordHit(ev.x, ev.y);
    if (!h) { if (ev.kind === 'move') S.record.hover = null; return []; }
    if (ev.kind === 'move' || ev.kind === 'down') { S.record.hover = h.kind.slice(4); if (S.record.confirm && (h.kind === 'rec-yes' || h.kind === 'rec-no')) S.record.confirm.cursor = h.kind === 'rec-yes' ? 0 : 1; if (h.kind.startsWith('rec-trainer')) S.record.focus = 'trainer'; else if (h.kind !== 'rec-page') S.record.focus = 'page'; return []; }
    if (ev.kind !== 'click') return [];
    S.record.hover = h.kind.slice(4);
    switch (h.kind) {
      case 'rec-yes': if (S.record.confirm) S.record.confirm.cursor = 0; return recordPress('a');
      case 'rec-no': if (S.record.confirm) S.record.confirm.cursor = 1; return recordPress('a');
      case 'rec-prev': recordTurn(-1); return [];
      case 'rec-next': recordTurn(1); return [];
      case 'rec-back': return back();
      case 'rec-trainer-prev': S.record.focus = 'trainer'; recordTrainer(-1); return [];
      case 'rec-trainer-next': S.record.focus = 'trainer'; recordTrainer(1); return [];
      case 'rec-reset': recordOpenConfirm(); return [];
      case 'rec-page': { S.record.focus = 'page'; return recordPress('a'); }
      default: return [];
    }
  }

  function view() {
    clampCursor();
    const base = { screen: S.path, env: S.env, mascot: mascotNow(), tick: S.tick, sound: S.sound };
    if (S.path === 'record') return recordView();
    if (S.path === 'about') {
      const pg = ABOUT_PAGES[S.about.page];
      return { ...base, title: false, about: { page: S.about.page, pages: ABOUT_PAGES.length, lines: pg.slice(), last: S.about.page === ABOUT_PAGES.length - 1 }, menu: null, msg: null };
    }
    const rs = rows();
    const cur = S.cursor[S.path];
    const row = rs[cur];
    return { ...base, title: true, menu: { rows: rs.map(({ values, ...r }) => r), cursor: cur }, about: null, msg: row ? helpFor(row) : ['', ''] };
  }

  /* ------------------------------------------------------------------------------------------ transitions */
  function go(path) {
    if (!PATHS.includes(path) || path === S.path) return [];
    S.from = S.path; S.path = path; S.flash = null;
    if (path === 'about') S.about.page = 0;
    if (path === 'team') normaliseTeamSel();
    if (path === 'record') { const rp = curRecordProfile(); S.record.profileId = rp ? rp.id : null; S.record.page = 0; S.record.focus = 'page'; S.record.confirm = null; S.record.hover = null; }
    clampCursor();
    return [{ type: 'screen', path }];
  }
  function back() {
    if (S.path === 'main') return [];
    const eff = go('main');
    return eff;
  }

  function change(row, dir) {
    if (S.flash) S.flash = null;
    if (row.kind !== 'choice') return [];
    if (S.path === 'quick') {
      if (row.id === 'format') S.quick.format = cycle(FORMATS, S.quick.format, dir);
      else if (row.id === 'cpu') S.quick.cpu = cycle(CPU_LEVELS, S.quick.cpu, dir);
      return [];
    }
    if (S.path === 'team') {
      const p = curProfile(), t = curTeam();
      if (row.id === 'profile') { const ids = profiles().map((x) => x.id); S.team.profileId = cycle(ids, p.id, dir); S.team.teamId = null; S.team.formatTouched = false; normaliseTeamSel(); }
      else if (row.id === 'teamsel') { const ids = p.teams.map((x) => x.id); S.team.teamId = cycle(ids, t.id, dir); S.team.formatTouched = false; normaliseTeamSel(); }
      else if (row.id === 'format') { S.team.format = cycle(allowedFormats(t.size), S.team.format, dir); S.team.formatTouched = true; }
      else if (row.id === 'cpu') S.team.cpu = cycle(CPU_LEVELS, S.team.cpu, dir);
    }
    return [];
  }

  function activate(row) {
    S.flash = null;
    if (S.path === 'main') {
      switch (row.id) {
        case 'quick': return go('quick');
        case 'team': return go('team');
        case 'record': return go('record');
        case 'builder': return [{ type: 'navigate', url: BUILDER_URL }];
        case 'import': return [{ type: 'navigate', url: IMPORT_URL }];
        case 'controls': return [{ type: 'controls' }];
        case 'sound': S.sound = !S.sound; return [{ type: 'sound', on: S.sound }];
        case 'about': return go('about');
        default: return [];
      }
    }
    if (row.kind === 'choice') return change(row, 1);
    if (row.id === 'back') return back();
    if (row.id === 'builder') return [{ type: 'navigate', url: BUILDER_URL }];
    if (row.id === 'start') {
      if (S.path === 'quick') return [{ type: 'battle', mode: 'quick', format: S.quick.format, cpu: S.quick.cpu }];
      const t = curTeam(), p = curProfile();
      if (!t || !p) return [];
      if (!t.legal) { S.flash = ['Fix ' + t.problems + ' problem' + (t.problems === 1 ? '' : 's') + ' in the TEAM BUILDER', 'first, then come back.']; return [{ type: 'blocked', reason: 'team-illegal' }]; }
      return [{ type: 'battle', mode: 'team', format: S.team.format, cpu: S.team.cpu, profileId: p.id, teamId: t.id }];
    }
    return [];
  }

  /* ------------------------------------------------------------------------------------------ public API */
  const api = {
    view,
    path: () => S.path,
    state: () => JSON.parse(JSON.stringify({ path: S.path, cursor: S.cursor, quick: S.quick, team: S.team, sound: S.sound, about: S.about, record: { page: S.record.page, focus: S.record.focus, confirm: S.record.confirm ? S.record.confirm.cursor : null }, data: { state: S.data.state, profiles: S.data.profiles.length } })),
    rows: () => rows().map(({ values, ...r }) => r),
    tick() { S.tick = (S.tick + 1) >>> 0; },
    setTick(n) { S.tick = n >>> 0; },
    setSound(on) { S.sound = !!on; },
    setMascot(id) { if (Number.isInteger(id)) S.mascot = id; },
    setEnv(id) { if (Number.isInteger(id)) S.env = id; },
    /** Show a message in the text box until the next move of the cursor (e.g. a team code that could not be made). */
    notify(lines) { S.flash = Array.isArray(lines) ? lines.slice(0, 2).map(String) : [String(lines), '']; },
    quickSettings: () => ({ ...S.quick }),
    /** The RECORD screen's selection (the trainer shown, the page, whether RESET RECORD is asking). */
    recordState: () => ({ profileId: curRecordProfile() ? curRecordProfile().id : null, page: S.record.page, focus: S.record.focus, confirming: !!S.record.confirm, pages: recordPages().length }),
    teamSettings: () => ({ profileId: S.team.profileId, teamId: S.team.teamId, cpu: S.team.cpu }),
    /** Team data from the store: { state: 'ready' | 'unavailable', note?, profiles: [{ id, name, teams: [{ id, name, size, legal, problems, names[], lead }] }], activeId } */
    setData(d) {
      S.data = { state: d && d.state === 'unavailable' ? 'unavailable' : 'ready', profiles: d && Array.isArray(d.profiles) ? d.profiles.map((p) => ({ id: String(p.id), name: String(p.name), teams: (p.teams || []).map((t) => ({ id: String(t.id), name: String(t.name), size: t.size | 0, legal: !!t.legal, problems: t.problems | 0, names: (t.names || []).map(String), lead: t.lead || null })), record: recordOf(p) })) : [], note: d && d.note || '', activeId: d && typeof d.activeId === 'string' ? d.activeId : null };
      if (d && d.activeId && !S.team.profileId && S.data.profiles.some((p) => p.id === d.activeId)) S.team.profileId = d.activeId;
      if (S.path === 'team' || S.team.profileId || S.team.teamId) normaliseTeamSel();
      if (S.path === 'record') { const rp = curRecordProfile(); S.record.profileId = rp ? rp.id : null; S.record.page = clamp(S.record.page, 0, recordPages().length - 1); S.record.confirm = null; }
      clampCursor();
    },
    goto(path) { return PATHS.includes(path) ? (path === S.path ? [] : go(path)) : []; },
    back,
    press(action) {
      if (S.path === 'record') return recordPress(action);
      if (S.path === 'about') {
        const last = ABOUT_PAGES.length - 1;
        if (action === 'a' || action === 'down' || action === 'right' || action === 'r') { if (S.about.page < last) { S.about.page++; return []; } return action === 'a' ? back() : []; }
        if (action === 'up' || action === 'left' || action === 'l') { if (S.about.page > 0) S.about.page--; return []; }
        if (action === 'b') return back();
        return [];
      }
      const rs = rows();
      if (!rs.length) return action === 'b' ? back() : [];
      const cur = S.cursor[S.path];
      switch (action) {
        case 'up': S.flash = null; S.cursor[S.path] = (cur + rs.length - 1) % rs.length; return [];
        case 'down': S.flash = null; S.cursor[S.path] = (cur + 1) % rs.length; return [];
        case 'left': return change(rs[cur], -1);
        case 'right': return change(rs[cur], 1);
        case 'a': return activate(rs[cur]);
        case 'b': return back();
        default: return [];
      }
    },
    /** Which thing is under the logical point? { kind: 'row', index, zone } | { kind: 'page' } | null. zone 'prev' = the left arrow of a choice row. */
    hit(x, y) {
      if (S.path === 'record') return recordHit(x, y);
      if (S.path === 'about') { const g = GEOM.about; return x >= g.x - 6 && y >= g.y - 6 && x < g.x + g.w + 6 && y < g.y + g.h + 6 ? { kind: 'page' } : null; }
      const rs = rows(), m = GEOM.menu, pitch = menuPitch(rs.length);
      if (x < m.x - 6 || x >= m.x + m.w + 6 || y < m.y || y >= m.y + rs.length * pitch) return null;
      const index = Math.floor((y - m.y) / pitch);
      const row = rs[index];
      const zone = row && row.kind === 'choice' && x < m.x + m.w * 0.45 + 6 && x > m.x + 38 ? 'prev' : 'main';
      return { kind: 'row', index, zone };
    },
    pointer(ev) {
      if (!ev) return [];
      if (S.path === 'record') return recordPointer(ev);
      if (ev.kind === 'wheel') { const n = Math.abs(ev.steps || 0); const act = (ev.steps || 0) > 0 ? 'down' : 'up'; let out = []; for (let i = 0; i < n; i++) out = out.concat(api.press(act)); return out; }
      const h = ev.x === undefined || ev.x === null ? null : api.hit(ev.x, ev.y);
      if (!h) return [];
      if (h.kind === 'page') return ev.kind === 'click' ? api.press('a') : [];
      if (ev.kind === 'move' || ev.kind === 'down') { if (S.cursor[S.path] !== h.index) S.flash = null; S.cursor[S.path] = h.index; return []; }
      if (ev.kind === 'click') {
        if (S.cursor[S.path] !== h.index) S.flash = null;
        S.cursor[S.path] = h.index;
        const row = rows()[h.index];
        if (row && row.kind === 'choice' && h.zone === 'prev') return change(row, -1);
        return api.press('a');
      }
      return [];
    },
    /** Rectangles the renderer and the tests use (logical pixels). */
    rects() { const m = GEOM.menu, p = menuPitch(rows().length); return rows().map((_, i) => ({ x: m.x - 4, y: m.y + i * p, w: m.w + 8, h: p })); },
  };
  return api;
}
