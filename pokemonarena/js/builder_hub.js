// pokemonarena/js/builder_hub.js -- THE TEAM BUILDER in the hub's 240x160 picture: the app's state machine. This file is the ROUTER and the shared context; the screens are in the family
// modules it lists (FAMILIES). pokemonarena/INAPP.md "The app interface" is the contract with the hub, and its last section ("BUILDER: as built") says how a later stage adds a screen.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness, nothing heavy imported (it is in the hub's first paint). Everything it knows about Pokemon comes in
// as DATA: builder_ctl.js makes a KIT (builder_kit.js: editor_state.js reduce, editor_data.js, the decoded pack) and hands it over with attach(kit); the profile being edited is handed over
// with setEditor(state). Until then every builder screen says it is opening.
//
// THE REDUCER IS THE LAW: a profile changes ONLY through X.dispatch(action) -> kit.reduce(state, action), with the same actions the old DOM editor sent. The ctl saves what the reducer made.
//
// WHO OWNS WHAT
//   this file          the registry of screens, the editor state (S.ed), the focus (which team / Pokemon / tab), the ONE text entry, the ONE pop-up menu, the YES / NO questions (the hub's dialog
//                      layer), the message box (help, a note, its pages), the autosave tag, and the methods builder_ctl.js calls
//   builder_home.js    builder (TRAINERS), builder-teams (TEAMS)
//   builder_team.js    builder-team (the six slots), builder-rules, builder-check
//   builder_mon.js     builder-mon (the Pokemon screen: its tabs; the BUILD tab)
//   builder_pick.js    builder-species, builder-item (the pickers and their filter panels)
//   builder_moves.js   the Pokemon screen's MOVES tab, and builder-move (the move picker and its filter panel)
//   builder_stats.js   the Pokemon screen's STATS tab (EVs or stat points, IVs, Hidden Power, the quick actions)
//   builder_portrait.js  builder-portrait (the ROM's 52 trainer heads), wired to the active trainer's menu
//   builder_io.js      builder-code (COPY / PASTE / ENTER a team code, the preview, ADD AS A NEW TEAM) and builder-test (the test battle); the team screen's CODE and TEST chips
//   builder_undo.js    UNDO and REDO: the rows they have on every editing screen
//   builder_parts.js   the furniture the screens are made of (list, pop-up, pages); builder_geom.js the rectangles
//
// A FAMILY   { id, screens: { path: { parent, title, need, create(X) } }, ext: { '<slot>': [entry, ...] } }
//   need     what must exist for the screen to be shown: 'none' | 'profile' | 'team' | 'mon'. A screen opened without it (a deep link, a reload, a team deleted in another tab) is left for the
//            nearest screen that can be shown (settle)
//   create   (X) -> { view(), press(action, info), pointer(ev), hit(x, y), rects(), state(), enter?(), leave?(), tick?(held), ready?(), onEditor?() }
//   view()   -> { kind, title, help: text | [line, line], say, ...what builder_screen.js draws for that kind }   (pagesFirst: true = A turns the pages of a long help before it acts)
//   ext      rows other screens show for this family (X.ext(slot, target)): 'trainers.rows', 'trainers.menu', 'teams.rows', 'teams.menu', 'team.chips', 'team.menu', 'mon.tabs'
//            (an entry: builder_parts.js "AN EXTENSION ENTRY")
//   tell     OPTIONAL screen method tell(msg) -> effects: what the ctl answers a screen with (the model's tell(path, msg)): a decoded team code, a copy the browser refused
//
// EFFECTS (app: 'builder', carried out by builder_ctl.js)
//   { type: 'opened', path, at, profileId }     a nested builder screen opened, or the Pokemon screen's tab changed (the ctl keeps the focus for this tab, so a reload comes back to the same team)
//   { type: 'edited' }                           the reducer committed an edit: schedule the autosave
//   { type: 'profile-create', name } / 'profile-open', id / 'profile-rename', id, name / 'profile-delete', id     the trainer list's actions (the store's, so the ctl's)
//   { type: 'pref', key, value }                 a per-viewer preference changed (the species picker's sort, the STATS tab's EVs / points view)
//   { type: 'code-length', teamId } / 'code-copy', teamId / 'code-paste' / 'code-decode', text     the team code (builder_io.js): the ctl makes it, copies it, reads the clipboard, decodes, and
//                                                answers with tell('builder-code', ...)
//   { type: 'test-start', teamId, foeId, format, cpu }     the test battle: the ctl saves, makes the codes and leaves for the battle page
// THE CTL'S DOOR (methods of the model beyond the hub's): attach, setPhase, setPrefs, setTrainers, setEditor, editor, apply, mapEditor, edit, setFlags, note, setFocus, focus, settle, showTeams,
//   tell(path, msg), undo(), redo() (Ctrl+Z / Ctrl+Y)

import { createEntrySlot } from './textentry.js';
import { wrapDialog } from './hub_dialog.js';
import { createPopupSlot, pagesOf, sentence } from './builder_parts.js';
import { BG, inR, clamp } from './builder_geom.js';
import { FAMILY as HOME } from './builder_home.js';
import { FAMILY as TEAM } from './builder_team.js';
import { FAMILY as MON } from './builder_mon.js';
import { FAMILY as PICK } from './builder_pick.js';
import { FAMILY as MOVES } from './builder_moves.js';
import { FAMILY as STATS } from './builder_stats.js';
import { FAMILY as PORTRAIT } from './builder_portrait.js';
import { FAMILY as IO } from './builder_io.js';
import { FAMILY as UNDO } from './builder_undo.js';

const ID = 'builder';
/** The screen families of the builder, in the order their paths are listed. A LATER STAGE ADDS ITS FAMILY HERE (and its painters in builder_screen.js). */
export const FAMILIES = Object.freeze([HOME, TEAM, MON, PICK, MOVES, STATS, PORTRAIT, IO, UNDO]);          // (the order is the order their rows take on a shared screen: PORTRAIT before UNDO in a trainer's menu)
export const NEEDS = Object.freeze(['none', 'profile', 'team', 'mon']);
export const PHASES = Object.freeze(['boot', 'loading', 'ready', 'nostore']);
const TITLE = 'Pokemon Arena - ';
const FRESH = Object.freeze({ repeat: false });

/** The screens and the extension rows of a list of families. Throws on a path defined twice or a definition that is not one (a programming error every test sees). */
export function collectFamilies(families) {
  const screens = {}, ext = {};
  for (const fam of families) {
    for (const [path, def] of Object.entries((fam && fam.screens) || {})) {
      if (screens[path]) throw new Error('builder: the screen ' + path + ' is defined twice');
      if (!def || typeof def.create !== 'function' || typeof def.parent !== 'string' || !NEEDS.includes(def.need)) throw new Error('builder: the screen ' + path + ' needs { parent, title, need, create }');
      screens[path] = def;
    }
    for (const [slot, list] of Object.entries((fam && fam.ext) || {})) (ext[slot] = ext[slot] || []).push(...list);
  }
  return { screens, ext };
}

/** An app descriptor (hub_apps.js) for a list of families: what APP is for FAMILIES, and what a test makes for families of its own. */
export function makeApp(families) {
  const { screens, ext } = collectFamilies(families);
  const paths = Object.freeze(Object.keys(screens));
  const parent = (path) => (screens[path] ? screens[path].parent : 'main');
  return Object.freeze({ id: ID, paths, parent, create: (ctx) => createBuilderHub(ctx, { screens, ext, paths, parent }) });
}

function createBuilderHub(ctx, reg) {
  const DEFS = reg.screens, EXT = reg.ext;
  const S = {
    kit: null, ed: null, phase: 'boot', trainers: null,
    flags: { saving: false, conflict: false, notSaved: false, failed: false },
    prefs: { speciesSort: 'dex', statsView: 'ev' },
    at: { teamId: null, monId: null, tab: 'build' },
    flash: null,                           // { text, pages, seq, bad }: a note in the message box until the next input
    pager: { key: '', page: 0 },           // which page of a long message is shown
    input: 0,                              // counts the inputs: a note set by an input survives the screen change the same input causes
  };
  const entry = createEntrySlot(), popup = createPopupSlot(ctx.measure);
  const pending = [], asks = new Map();
  const PX = ctx.msgPx - 12;                                   // a message line, less the room the "more" arrow keeps
  let cache = { profile: null, map: new Map() };

  /* ------------------------------------------------------------------------------------------ what the screens are given */
  const profile = () => (S.ed ? S.ed.profile : null);
  const team = () => { const p = profile(); return p && S.at.teamId ? S.kit.ES.findTeam(p, S.at.teamId) : null; };
  const mon = () => { const t = team(); return t && S.at.monId && t.monIds.includes(S.at.monId) ? S.kit.ES.findMon(profile(), S.at.monId) : null; };
  /** A value worked out from the profile, kept until the profile changes (the reducer never mutates: a new edit is a new object). */
  function memo(key, make) {
    const p = profile();
    if (cache.profile !== p) cache = { profile: p, map: new Map() };
    if (!cache.map.has(key)) cache.map.set(key, make());
    return cache.map.get(key);
  }
  function flash(text, bad) {
    const t = Array.isArray(text) ? text.map(String) : String(text === undefined || text === null ? '' : text);
    if (!(Array.isArray(t) ? t.some(Boolean) : t.trim())) { S.flash = null; return; }
    S.flash = { text: Array.isArray(t) ? t.join(' ') : t, pages: pagesOf(t, ctx.measure, PX, ctx.msgPx), seq: S.input, bad: !!bad };
    S.pager = { key: '', page: 0 };
  }
  /** THE ONLY WAY A PROFILE CHANGES. -> the new editor state (its `error`, `notice`, `result` are the reducer's), or null when no profile is open. The reducer's words go to the message box. */
  function dispatch(action, o) {
    if (!S.ed || !S.kit) return null;
    const prev = S.ed, next = S.kit.reduce(prev, action);
    S.ed = next;
    if (!(o && o.quiet)) { if (next.error) flash(sentence(next.error.message), true); else if (next.notice) flash(sentence(next.notice.message), false); }
    if (next.seq !== prev.seq) pending.push({ app: ID, type: 'edited' });
    return next;
  }
  /** A YES / NO question through the hub's dialog layer. spec: { id, text | pages, options?, cursor? }; answer(value) -> effects (value: the option's index). -> whether it was opened. */
  function ask(spec, answer) {
    const id = ID + ':' + spec.id, options = spec.options || ['YES', 'NO'];
    const pages = spec.pages || wrapDialog(spec.text, ctx.measure, PX);          // (less the room the dialog's own "more" arrow takes at the end of a line)
    if (!ctx.dialog.open({ id, pages, choice: { options, cursor: spec.cursor === undefined ? options.length - 1 : spec.cursor } })) return false;
    asks.set(id, answer); return true;
  }
  const speciesName = (id) => { const sp = S.kit && S.kit.pack.species[id]; return sp && sp.name ? S.kit.text(sp.name) : 'Unknown ' + id; };
  /** A team as the screens show it: its Pokemon, the rules module's verdict, and one word for it. */
  function teamCheck(teamId) {
    return memo('check:' + teamId, () => {
      const p = profile(), t = S.kit.ES.findTeam(p, teamId);
      if (!t) return { mons: [], v: { ok: true, count: 0, team: [], mons: [] }, status: 'empty', count: 0 };
      const mons = S.kit.ES.teamMonsOf(p, teamId);
      let v; try { v = S.kit.ED.validationView(S.kit.pack, mons, t.ruleset); } catch (e) { v = { ok: false, count: 1, team: [{ code: 'internal', text: String(e && e.message ? e.message : e), message: '', path: '', label: 'Team' }], mons: mons.map(() => []) }; }
      return { mons, v, status: !mons.length ? 'empty' : v.ok ? 'legal' : 'bad', count: v.count };
    });
  }
  const statusWords = (c) => (c.status === 'empty' ? 'Empty' : c.status === 'legal' ? 'Legal' : c.count + (c.count === 1 ? ' problem' : ' problems'));
  /** The trainers as the list shows them: what the ctl read from the store (or, until it has, what the hub knows), with the profile being edited as it is NOW. */
  function trainers() {
    const base = S.trainers || ctx.profiles().map((p) => ({ id: p.id, name: p.name, readOnly: !!p.readOnly, teams: p.teams.length, mons: p.teams.reduce((n, t) => n + t.size, 0), avatar: null, unreadable: false }));
    const p = profile();
    if (!p) return base;
    const live = { id: p.id, name: p.trainerName, readOnly: !!S.ed.readOnly, teams: p.teams.length, mons: p.box.length, avatar: p.avatar && typeof p.avatar === 'object' ? { kind: p.avatar.kind, id: p.avatar.id } : null, unreadable: false };
    return base.some((t) => t.id === p.id) ? base.map((t) => (t.id === p.id ? live : t)) : base.concat([live]);
  }

  const X = {
    ID, ctx,
    kit: () => S.kit, ed: () => S.ed, profile, team, mon, memo,
    readOnly: () => !!(S.ed && S.ed.readOnly),
    activeId: () => (S.ed ? S.ed.profile.id : null),
    trainers, teamCheck, statusWords, speciesName,
    monName: (m) => (m && m.nickname ? m.nickname : m ? speciesName(m.species) : ''),
    rules: (id) => S.kit.rules(id),
    /** The focus: { teamId, monId, tab }. setAt(patch) changes it (a screen sets it BEFORE it opens the screen that shows it). */
    at: () => S.at,
    setAt(patch) { Object.assign(S.at, patch); },
    prefs: () => S.prefs,
    setPref(key, value) { if (S.prefs[key] === value) return; S.prefs[key] = value; pending.push({ app: ID, type: 'pref', key, value }); },
    dispatch, flash, ask,
    /** Ask something of the ctl from where no effects are returned (a screen's enter()): it leaves with the effects of the input that caused it. */
    emit(effect) { pending.push(effect); },
    /** The open screen may have lost what it shows (an undo took the team away): -> the move to the nearest screen that can be shown, or []. */
    settle: () => settle(),
    go: (path, o) => ctx.go(path, o), back: () => ctx.back(),
    entry, popup,
    measure: ctx.measure, msgPx: ctx.msgPx,
    eff: (type, more) => ({ app: ID, type, ...(more || {}) }),
    /** The rows other families registered for a slot of this screen ('team.chips', 'mon.tabs' ...), in registration order; an entry with when(X, target) is left out while that is false (target: the trainer or the team a menu was opened on). */
    ext: (slot, target) => (EXT[slot] || []).filter((e) => typeof e.when !== 'function' || e.when(X, target === undefined ? null : target)),
    /** Another screen's own object (a picker is told what it picks for before it is opened). */
    screen: (path) => screens[path] || null,
  };
  const screens = {};
  for (const path of reg.paths) screens[path] = DEFS[path].create(X);

  /* ------------------------------------------------------------------------------------------ where the player can be */
  /** Where the player must be instead of `path`, or null when `path` can be shown. */
  function target(path) {
    const d = DEFS[path]; if (!d || d.need === 'none') return null;
    if (!S.ed) return ID;
    if (d.need !== 'profile') {
      if (!team()) return 'builder-teams';
      if (d.need === 'mon' && !mon()) return 'builder-team';
    }
    const s = screens[path];
    return typeof s.ready === 'function' && !s.ready() ? d.parent : null;
  }
  /** The open screen cannot be shown (its team is gone, the page was opened at its address): go to the nearest one that can. -> effects. */
  function settle() {
    const p = ctx.path();
    if (!DEFS[p] || S.phase !== 'ready') return [];
    const to = target(p);
    return to && to !== p ? ctx.go(to) : [];
  }

  /* ------------------------------------------------------------------------------------------ the message box */
  const WAIT = Object.freeze({ boot: ['Opening the Team Builder...', ''], loading: ['Reading your trainers...', ''], nostore: ['Storage could not be opened here,', 'so there are no trainers to edit.'] });
  function screenView(path) {
    if (S.phase === 'ready' && !target(path)) return screens[path].view();
    return { kind: 'wait', title: 'TEAM BUILDER', lines: S.phase === 'nostore' ? ['NO STORAGE'] : ['LOADING...'], help: WAIT[S.phase] || WAIT.loading, say: 'Team Builder.' };
  }
  /**
   * The text in the message box: a note (what the last input was answered with: it stands over an open pop-up's help too, so "Undid: change move." is read while the menu stays open), else
   * the open pop-up's help, else the screen's own help. -> { key, pages, page, first } (first: A turns its pages before it does anything else).
   */
  function messageOf(sv) {
    let pages, key, first = false;
    const ph = !S.flash && popup.isOpen() ? popup.help() : null;
    if (S.flash) { pages = S.flash.pages; key = 'f:' + S.flash.seq + ':' + S.flash.text; first = true; }
    else if (ph) { pages = pagesOf(ph, ctx.measure, PX, ctx.msgPx); key = 'p:' + JSON.stringify(ph); }
    else { const hp = sv.help || ['', '']; pages = pagesOf(hp, ctx.measure, PX, ctx.msgPx); key = 'h:' + JSON.stringify(hp); first = !!sv.pagesFirst; }
    return { key, pages, first, page: S.pager.key === key ? clamp(S.pager.page, 0, pages.length - 1) : 0 };
  }
  /** Turn the page of the message. wrap: after the last page comes the first (SELECT, a tap on the box); without it the last page stays. -> whether a page was turned. */
  function turnPage(path, wrap) {
    const m = messageOf(screenView(path));
    if (m.pages.length < 2) return false;
    if (m.page >= m.pages.length - 1) { if (!wrap) return false; S.pager = { key: m.key, page: 0 }; return true; }
    S.pager = { key: m.key, page: m.page + 1 }; return true;
  }
  function tagNow() {
    if (!S.ed) return null;
    if (S.ed.readOnly) return { text: 'READ-ONLY', bad: true };
    if (S.flags.conflict) return { text: 'CHANGED', bad: true };
    if (S.flags.notSaved || S.flags.failed) return { text: 'NOT SAVED', bad: true };
    if (S.flags.saving || S.kit.ES.isDirty(S.ed)) return { text: 'SAVING', bad: false };
    return { text: 'SAVED', bad: false };
  }
  const TAG_SAYS = Object.freeze({ 'READ-ONLY': 'This profile is read-only.', CHANGED: 'Changed in another tab.', 'NOT SAVED': 'Not saved.' });
  /** A note lives until the next input: one that an EARLIER input left (under a pop-up that stayed open) goes now. */
  const dropStale = () => { if (S.flash && S.flash.seq !== S.input) S.flash = null; };

  function history(type) {
    if (S.phase !== 'ready' || !S.ed || entry.isOpen()) return [];
    S.input++;
    dispatch({ type });
    return out(settle());
  }
  /** What a handler returned, plus what the reducer and the screens asked of the ctl meanwhile (one 'edited' however many edits the input made). */
  function out(fx) {
    const list = Array.isArray(fx) ? fx.slice() : [];
    let edited = false;
    for (const e of pending.splice(0)) { if (e.type === 'edited') { if (edited) continue; edited = true; } list.push(e); }
    return list;
  }

  return {
    id: ID, paths: reg.paths, parent: reg.parent,

    /* ---------------------------------------------------------------------------------------- the hub's calls */
    enter(path) {
      if (S.flash && S.flash.seq !== S.input) S.flash = null;
      S.pager = { key: '', page: 0 };
      popup.close(); entry.close();
      if (S.phase === 'ready') {
        const to = target(path); if (to && to !== path) return ctx.go(to);
        const s = screens[path];
        if (s && typeof s.enter === 'function') s.enter();          // (only a screen that can be shown is entered: one opened before the profile is read has nothing to stand on yet)
      }
      // a NESTED screen tells the ctl it was opened (the ctl keeps the focus for this tab). The trainer list needs no word: the page tells the ctl itself when the builder is entered
      return out(path === ID ? [] : [{ app: ID, type: 'opened', path, at: { ...S.at }, profileId: S.ed ? S.ed.profile.id : null }]);
    },
    leave(path) {
      entry.close(); popup.close();                                     // a screen that closes takes its text entry, its pop-up and its questions with it
      for (const id of asks.keys()) ctx.dialog.close(id);
      asks.clear();
      const s = screens[path];
      if (s && typeof s.leave === 'function') s.leave();
    },
    press(path, action, info) {
      S.input++;
      const efx = entry.press(action); if (efx) return out(efx);
      const pfx = popup.press(action); if (pfx) { dropStale(); return out(pfx); }
      if (action === 'select') { turnPage(path, true); return out([]); }
      if (action === 'a' && S.phase === 'ready') { const m = messageOf(screenView(path)); if (m.first && m.page < m.pages.length - 1) { S.pager = { key: m.key, page: m.page + 1 }; return out([]); } }          // a note is read to its end first
      S.flash = null;
      if (S.phase !== 'ready' || target(path)) return out(action === 'b' ? ctx.back() : []);
      return out(screens[path].press(action, info || FRESH));
    },
    hit(path, x, y) {
      if (entry.isOpen()) return entry.hit(x, y);
      const ph = popup.hit(x, y); if (ph !== undefined) return ph;
      if (inR(BG.msg, x, y)) return messageOf(screenView(path)).pages.length > 1 ? { kind: 'msg' } : null;
      return S.phase === 'ready' && !target(path) ? screens[path].hit(x, y) || null : null;
    },
    pointer(path, ev) {
      if (!ev) return [];
      const acts = ev.kind === 'click' || ev.kind === 'wheel';
      if (acts) S.input++;
      const efx = entry.pointer(ev); if (efx) return out(efx);
      const pfx = popup.pointer(ev); if (pfx) { if (acts) dropStale(); return out(pfx); }
      if (ev.kind === 'click' && inR(BG.msg, ev.x, ev.y)) { turnPage(path, true); return out([]); }          // a tap on the message box turns the page of a long text
      if (S.phase !== 'ready' || target(path)) return out([]);
      const s = screens[path];
      if (acts) { S.flash = null; return out(s.pointer(ev)); }
      const before = JSON.stringify(s.state());
      const fx = s.pointer(ev);
      if (S.flash && JSON.stringify(s.state()) !== before) S.flash = null;          // (a note stays while the pointer only passes over the row it is about)
      return out(fx);
    },
    rects(path) { return entry.isOpen() ? entry.rects() : popup.isOpen() ? popup.rects() : S.phase === 'ready' && !target(path) ? screens[path].rects() : []; },
    tick(path, held) { const s = screens[path]; return s && typeof s.tick === 'function' && S.phase === 'ready' ? out(s.tick(held)) : []; },
    onData() { return []; },
    onDialog(id, value) { const fn = asks.get(id); if (!fn) return []; asks.delete(id); S.input++; return out(fn(value)); },
    wantsText: () => entry.isOpen(),
    type: (_path, input) => { S.input++; return out(entry.type(input) || []); },
    view(path, base) {
      const sv = screenView(path), m = messageOf(sv);
      const { help, pagesFirst, say, menu, ...rest } = sv;
      const tag = tagNow();
      return {
        ...base, screen: path, app: ID, mascot: null, menu: menu || null, msg: m.pages[m.page].slice(),
        builder: { ...rest, tag: rest.noTag ? null : tag, note: !!S.flash, more: m.page < m.pages.length - 1, page: m.page + 1, pages: m.pages.length, popup: popup.view(),
          say: String(say || ''), text: m.pages.flat().filter(Boolean).join(' '), warn: tag && tag.bad ? TAG_SAYS[tag.text] || '' : '' },
        entry: entry.view(),
      };
    },
    /** The screen reader's words: the screen and what is highlighted, the open pop-up's rows, the WHOLE message (every page), and a tag only when it is bad news (SAVING / SAVED come and go by themselves). */
    speak(v) {
      const b = v && v.builder; if (!b) return '';
      const pop = b.popup ? 'Menu: ' + b.popup.rows.map((r, i) => (i === b.popup.cursor ? 'selected ' : '') + r.label + (r.value !== undefined ? ' ' + r.value : '')).join(', ') + '.' : '';
      return [b.say, pop, b.text, b.warn].filter(Boolean).join(' ');
    },
    title: (path) => TITLE + ((DEFS[path] && DEFS[path].title) || 'Team Builder'),
    state() {
      const tag = tagNow(), scr = {};
      for (const p of reg.paths) scr[p] = screens[p].state();
      return { phase: S.phase, profile: S.ed ? S.ed.profile.id : null, seq: S.ed ? S.ed.seq : 0, undo: S.ed ? S.ed.undo.length : 0, redo: S.ed ? S.ed.redo.length : 0, at: { ...S.at }, tag: tag ? tag.text : null, note: S.flash ? S.flash.text.slice(0, 80) : null, page: S.pager.page,
        popup: popup.state(), entry: entry.isOpen() ? entry.entry().state() : null, screens: scr };
    },

    /* ---------------------------------------------------------------------------------------- the ctl's door (builder_ctl.js; a Node test plays the ctl) */
    /** The kit (builder_kit.js). The screens can work from now on; the trainers are still being read. */
    attach(kit) { S.kit = kit; if (S.phase === 'boot') S.phase = 'loading'; },
    kit: () => S.kit,
    /** 'loading' (the store is being read) | 'ready' | 'nostore' (storage could not be opened at all). */
    setPhase(p) { if (PHASES.includes(p) && (p === 'boot' || S.kit)) S.phase = p; },
    phase: () => S.phase,
    setPrefs(p) { if (p && typeof p === 'object') for (const k of Object.keys(S.prefs)) if (typeof p[k] === 'string') S.prefs[k] = p[k]; },
    /** The trainer list as the store has it: [{ id, name, readOnly, teams, mons, avatar: { kind, id } | null, unreadable }] (null: fall back to what the hub knows). */
    setTrainers(list) { S.trainers = Array.isArray(list) ? list.map((t) => ({ id: String(t.id), name: typeof t.name === 'string' ? t.name : '', readOnly: !!t.readOnly, teams: t.teams | 0, mons: t.mons | 0, avatar: t.avatar && typeof t.avatar === 'object' ? { kind: String(t.avatar.kind), id: t.avatar.id | 0 } : null, unreadable: !!t.unreadable })) : null; },
    /** The profile being edited, as an editor_state.js state (kit.initialState(profile, { readOnly })), or null: none is open. */
    setEditor(state) { S.ed = state || null; cache = { profile: null, map: new Map() }; for (const s of Object.values(screens)) if (typeof s.onEditor === 'function') s.onEditor(); },
    editor: () => S.ed,
    /** Bookkeeping the save pipeline needs ('saved', 'rebase', 'setIdentity', 'load'): reduced like any action, but it says nothing in the message box and asks for no save. -> the state. */
    apply(action) { if (!S.ed || !S.kit) return null; S.ed = S.kit.reduce(S.ed, action); return S.ed; },
    /** Replace the editor state by fn(state) (the ctl carries the STORED battle record over when the player keeps their edits: profile.js withStoredRecord). */
    mapEditor(fn) { if (S.ed) S.ed = fn(S.ed) || S.ed; return S.ed; },
    /** An edit made by the ctl itself (the active trainer's rename): reduced as the screens' edits are, quietly; the ctl schedules its own save. -> the state. */
    edit(action) { const r = dispatch(action, { quiet: true }); for (let i = pending.length - 1; i >= 0; i--) if (pending[i].type === 'edited') pending.splice(i, 1); return r; },
    /** What the save pipeline knows: { saving, conflict, notSaved, failed } (the autosave tag is made from these and from the reducer's seq / savedSeq). */
    setFlags(f) { for (const k of Object.keys(S.flags)) if (f && k in f) S.flags[k] = !!f[k]; },
    flags: () => ({ ...S.flags }),
    /** A note in the message box until the next input ("Profile created."). */
    note(text, bad) { S.input++; flash(text, bad); },
    setFocus(at) { if (!at || typeof at !== 'object') return; S.at = { teamId: typeof at.teamId === 'string' ? at.teamId : null, monId: typeof at.monId === 'string' ? at.monId : null, tab: typeof at.tab === 'string' ? at.tab : 'build' }; },
    focus: () => ({ ...S.at }),
    settle,
    /** A trainer was opened or made: show its teams (from the trainer list), or put the open screen right. -> effects for env.run. */
    showTeams() { if (S.phase !== 'ready' || !S.ed) return settle(); return ctx.path() === ID ? ctx.go('builder-teams') : settle(); },
    /** The ctl answers a screen (a decoded team code, a copy the browser refused): the screen's own tell(msg). -> effects for env.run. */
    tell(path, msg) { const s = screens[path]; if (!s || typeof s.tell !== 'function' || S.phase !== 'ready') return []; S.input++; return out(s.tell(msg) || []); },
    /** Ctrl+Z / Ctrl+Y: one step back or forward through the reducer's stack, from any builder screen (not under a text entry: a word being typed is not an edit yet). -> effects for env.run. */
    undo() { return history('undo'); },
    redo() { return history('redo'); },
    /** (tests) the screens' own objects, and the registry this model was made from. */
    screens, registry: reg,
  };
}

export const APP = makeApp(FAMILIES);
