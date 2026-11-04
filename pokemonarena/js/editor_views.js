// pokemonarena/js/editor_views.js -- the screens of the team / profile editor: DOM only, no storage, no rules of its own.
//
// Browser module. Every function takes the `app` object built by editor_app.js (state, pack, art kit, dispatch, navigation, store actions) and
// returns a view { el, update() }. Text from the player, an import or the ROM is ALWAYS put in the page with textContent / text nodes; nothing
// here uses innerHTML, so a hostile nickname, team name or file cannot become markup.
//
// EVERY PICTURE is a canvas painted from ROM bytes by editor_art.js (type badges, move-category icons, party icons, front sprites, the HP-bar
// tiles behind the stat bars, nature arrows, gender glyphs, trainer portraits). Labels, numbers and form controls are DOM text, which the brief
// accepts on editor pages. Where the ROM has no art for something (held-item icons, the shiny star, a ruleset logo) the page shows words, never
// an invented picture; the About box lists those gaps.
//
// All legality shown here is asked of rules.js through editor_data.js; the reason shown is the code's RULE_CODES text.

import {
  STAT_ORDER, STAT_LABELS, STAT_SHORT, moveCatalog, filterMoves, itemCatalog, speciesSearch, speciesRow, abilityOptions, natureOptions, derived, budgets,
  validationView, monProblems, genderOptions, storedView, uniqueTypes, reasonText, speciesExclusions, SPECIES_SORTS, SPECIES_SORT_IDS, speciesTypeChoices, speciesComparator, speciesEnterChoice,
} from './editor_data.js';
import {
  findTeam, findMon, teamMonsOf, rulesetIdOfMon, parseRulesetId, buildRulesetId, rulesetLabel, LEVEL_MODES, EDITOR_LIMITS, unusedMons, AVATAR_PRESETS,
} from './editor_state.js';
import { resolveRuleset, RULE_CODES } from './rules.js';
import { abilityReason, unsupportedInnates } from './engine_support.js';
import { E as ENGINE_E } from './engine_data.js';
import { paintCanvas, BAR_TILES } from './editor_art.js';
import { battleUrl, formatForTeamSize, formatsForTeamSize, seedFrom, FORMATS, CPU_LEVELS, TABS, routeHash } from './editor_links.js';
import { PROFILE_LIMITS, IMPORT_CODES } from './profile.js';
import { TEAMCODE_ERRORS } from './teamcode.js';
import { IDENTITY_NOTICE } from './identity.js';
import { HIDDEN_POWER_TYPES } from './stats.js';

/* ================================================================================================ DOM helpers */

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'readOnly' || k === 'multiple') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.appendChild(typeof k === 'object' && 'nodeType' in k ? k : document.createTextNode(String(k)));
  }
}
const txt = (s) => document.createTextNode(String(s));

/** host.replaceChildren(...kids) that SKIPS null / false / empty entries (replaceChildren would write the text "null" for a null). */
export function put(host, ...kids) { host.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== '')); }

/** Rebuild `host`'s children from build(), keeping keyboard focus on the element with the same data-fk (and the caret in a text field). */
export function rebuild(host, build) {
  const a = document.activeElement;
  const key = a && host.contains(a) && a.dataset ? a.dataset.fk : null;
  let sel = null;
  try { if (key && typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch (_e) { /* a number input has no caret API */ }
  put(host, build());
  if (key) {
    const n = [...host.querySelectorAll('[data-fk]')].find((x) => x.dataset.fk === key);
    if (n) { try { n.focus({ preventScroll: true }); if (sel && n.setSelectionRange) n.setSelectionRange(sel[0], sel[1]); } catch (_e) { /* ignore */ } }
  }
}

let uidN = 0;
const uid = (p) => p + (++uidN);

/** Strict whole-number parse of what a person typed: '12', '-3'. Anything else is null (the caller reverts the field). */
export function parseWhole(s) { const t = String(s).trim(); return /^-?\d{1,6}$/.test(t) ? Number(t) : null; }

/* ================================================================================================ ROM art in the DOM */

/** A <canvas> showing a ROM image at a whole-number scale. `label` becomes its accessible name (empty = decorative). */
export function artEl(img, scale, label) {
  const c = document.createElement('canvas');
  c.className = 'rom';
  paintCanvas(c, img);
  c.style.width = img.width * scale + 'px';
  c.style.height = img.height * scale + 'px';
  if (label) { c.setAttribute('role', 'img'); c.setAttribute('aria-label', label); } else c.setAttribute('aria-hidden', 'true');
  return c;
}
function typeName(app, id) { const t = app.pack.types[id]; return t ? t.name : '?'; }
/** The species' name, or "Unknown #N" for an id this ROM has no entry for (a hand-edited file or a stale profile). Never throws. */
export function speciesName(app, id) { const sp = Number.isInteger(id) ? app.pack.species[id] : null; return sp ? sp.name : 'Unknown #' + id; }
/** The mark shown where a picture does not exist: a "?" in the ROM's own font (never an invented drawing). */
export function noPicEl(app, scale, label, box = 32) {
  const g = app.art.text('normal', '?', glyphColors.plain);
  const s = Math.max(1, scale | 0);
  return h('span', { class: 'nopic', style: `width:${box * s}px;height:${box * s}px`, role: 'img', 'aria-label': label || 'no picture' }, artEl(g, s * 2, ''));
}
export const typeBadgeEl = (app, id, scale = 1) => artEl(app.art.typeBadge(id), scale, typeName(app, id) + ' type');
export const categoryEl = (app, cat, scale = 1) => artEl(app.art.categoryIcon(cat), scale, ['Physical', 'Special', 'Status'][cat] + ' move');
export function iconEl(app, species, { shiny = false, scale = 1, frame = 0, label } = {}) {
  let img = null;
  try { img = app.art.monIcon(species, { shiny, frame }); } catch (_e) { img = null; }   // the kit answers null for an unknown id; a rude kit must still not take the screen down
  const sp = Number.isInteger(species) ? app.pack.species[species] : null;
  if (!img) return noPicEl(app, scale, label === undefined ? speciesName(app, species) : label);
  return artEl(img, scale, label === undefined ? (sp ? sp.name : '') : label);
}
const glyphColors = { up: { fg: [255, 107, 107], shadow: [96, 40, 40] }, down: { fg: [107, 155, 255], shadow: [40, 56, 96] }, plain: { fg: [226, 226, 232], shadow: [72, 72, 84] } };
export function glyphEl(app, str, kind = 'plain', scale = 1, label) {
  const g = app.art.text('normal', str, glyphColors[kind]);
  return artEl(g, scale, label);
}
const typeBadges = (app, sp, scale = 1) => (sp ? h('span', { class: 'minis' }, uniqueTypes(sp).map((t) => typeBadgeEl(app, t, scale))) : null);

/* ---- sprite animation: one timer flips every animated canvas between the ROM's two frames ---- */
const animated = new Set();
let animTimer = null;
export function spriteEl(app, species, { shiny = false, female = false, scale = 2 } = {}) {
  let spr = null;
  try { spr = app.art.frontSprite(species, { shiny, female }); } catch (_e) { spr = null; }
  const c = document.createElement('canvas');
  c.className = 'rom';
  if (!spr) { c.width = 64; c.height = 64; c.style.width = 64 * scale + 'px'; c.style.height = 64 * scale + 'px'; return c; }
  paintCanvas(c, spr.frames[0]);
  c.style.width = 64 * scale + 'px'; c.style.height = 64 * scale + 'px';
  c.setAttribute('role', 'img'); c.setAttribute('aria-label', spr.name + (shiny ? ' (shiny)' : ''));
  if (spr.frames.length > 1) { c._frames = spr.frames; c._f = 0; animated.add(c); if (!animTimer) animTimer = setInterval(tickSprites, 600); }
  return c;
}
function tickSprites() {
  const reduce = (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) || document.hidden || (window.__editorApp && window.__editorApp.reducedMotion());
  for (const c of [...animated]) {
    if (!c.isConnected) { animated.delete(c); continue; }
    if (reduce) continue;
    c._f = 1 - c._f; paintCanvas(c, c._frames[c._f]);
  }
  if (!animated.size && animTimer) { clearInterval(animTimer); animTimer = null; }
}

/* ================================================================================================ small widgets */

/** \u2212 [ n ] + : the \u2212 and + buttons commit immediately; typing commits on change (blur / Enter). onChange(number) always gets a whole number. */
export function stepper(app, { fk, label, value, min, max, step = 1, onChange, disabled = false, coalesce, hideBtns = false }) {
  const input = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': label, value: String(value), min, max, step: 1, disabled, 'data-fk': fk, dataset: { fk } });
  input.addEventListener('change', () => {
    const n = parseWhole(input.value);
    if (n === null) { app.toast(label + ': enter a whole number', 'bad'); input.value = String(value); return; }
    onChange(n, coalesce);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); input.dispatchEvent(new Event('change')); } });
  const dec = h('button', { type: 'button', class: 'btn', 'aria-label': 'Decrease ' + label, disabled: disabled || value <= min, onClick: () => onChange(value - step, coalesce) }, '\u2212');
  const inc = h('button', { type: 'button', class: 'btn', 'aria-label': 'Increase ' + label, disabled: disabled || value >= max, onClick: () => onChange(value + step, coalesce) }, '+');
  return h('span', { class: 'stepper' }, hideBtns ? null : dec, input, hideBtns ? null : inc);
}

export function segmented(items, { label, current, onPick, kind = 'pressed' }) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    items.map((it) => h('button', { type: 'button', 'aria-pressed': String(it.value === current), disabled: it.disabled, title: it.title, 'aria-label': it.aria, dataset: { v: it.value }, onClick: () => onPick(it.value) }, it.node || it.label)));
}

/** "There is room" for an open fold: a wide window that is also TALL. The Pokemon picker's open Sort and filter block needs a window of about 725 px (its list keeps a 220 px
 *  floor), so a laptop (1366x768 is ~640 tall), a 1080p screen at 150% (585-640) or a phone held sideways (844x390) starts folded however wide it is. editor.css uses the exact
 *  complement (`not all and (min-height: 760px)`) for the short-window layout; change the two together. */
const FOLD_ROOMY = '(min-width: 700px) and (min-height: 760px)';

/** A folded block of controls (Filters, Options): closed on a phone or a short window so the LIST gets the screen, open where there is room (FOLD_ROOMY).
 *  A button toggles a container's "hidden" attribute. (Not <details>: controls inside a CLOSED <details> still report a normal rectangle and
 *  display:block, so the input layer's focus search picks them, focus() silently fails, and a controller gets stuck on the summary. Measured.) */
export function fold(summary, ...kids) {
  const roomy = typeof matchMedia === 'function' && matchMedia(FOLD_ROOMY).matches;
  const id = uid('fold');
  const box = h('div', { class: 'stack fold-body', id, hidden: !roomy }, kids);
  const btn = h('button', { type: 'button', class: 'fold-btn', 'aria-expanded': String(roomy), 'aria-controls': id }, summary);
  btn.addEventListener('click', () => { const open = box.hidden; box.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
  return h('div', { class: 'fold' }, btn, box);
}

/** { el, close } -- a modal sheet with a focus trap, Escape, scrim click and focus restoration. `fixed`: the sheet itself does not scroll, the LIST inside it does
 *  (one scrollbar, and the search box and filters stay where they are while the list moves). `sheetClass` / `bodyClass` add classes to the sheet / its body: the Pokemon picker passes 'picker' and 'has-vlist',
 *  which editor.css keys its short-window rules on. */
export function openModal(app, { title, body, footer, onClose, wide = false, fixed = false, labelId = uid('dlg'), sheetClass = '', bodyClass = '' }) {
  const root = document.getElementById('modalRoot');
  const prev = document.activeElement;
  const closeBtn = h('button', { type: 'button', class: 'btn small', 'aria-label': 'Close ' + title }, 'Close');
  const sheet = h('div', { class: ('sheet ' + sheetClass).trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId },
    h('header', null, h('h2', { id: labelId }, title), closeBtn), h('div', { class: ((fixed ? 'body fixed ' : 'body ') + bodyClass).trim() }, body), footer ? h('footer', null, footer) : null);
  const scrim = h('div', { class: 'scrim' }, sheet);
  let closed = false;
  const close = (reason) => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    document.body.style.overflow = '';
    if (prev && prev.isConnected) { try { prev.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    if (onClose) onClose(reason);
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close('escape'); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
  closeBtn.addEventListener('click', () => close('button'));
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close('scrim'); });
  document.addEventListener('keydown', onKey, true);
  root.appendChild(scrim);
  document.body.style.overflow = 'hidden';
  const auto = sheet.querySelector('[data-autofocus]') || closeBtn;
  setTimeout(() => { try { auto.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }, 0);
  return { el: sheet, close };
}

export function confirmDialog(app, { title, message, confirmLabel = 'Confirm', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } m.close(); };
    const input = requireText ? h('input', { type: 'text', 'aria-label': `Type ${requireText} to confirm`, autocomplete: 'off', autocapitalize: 'off', 'data-autofocus': '1', dataset: { fk: 'confirm-text' } }) : null;
    const ok = h('button', { type: 'button', class: 'btn ' + (danger ? 'danger' : 'primary'), disabled: !!requireText, onClick: () => finish(true) }, confirmLabel);
    if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== requireText; });
    const m = openModal(app, {
      title, body: [].concat(message).map((p) => h('p', null, p)).concat(input ? [h('label', null, `Type ${requireText} to confirm`, input)] : []),
      footer: [h('button', { type: 'button', class: 'btn', onClick: () => finish(false) }, 'Cancel'), ok], onClose: () => finish(false),
    });
  });
}

/* ================================================================================================ problems */

function problemList(app, problems, { heading } = {}) {
  if (!problems.length) return null;
  // W1 fix D6 (round 3): a problem is said in words; the rules' code and their own wording are for a developer and live in the row's hover text (title), not on the screen
  return h('ul', { class: 'problems', 'aria-label': heading || 'Problems' }, problems.map((p) => h('li', { title: p.code + (p.message && p.message !== p.text ? ' - ' + p.message : ''), dataset: { code: p.code } },
    h('div', null, h('span', { class: 'where' }, p.label + ': '), p.text))));
}

/* ================================================================================================ pickers */

/** The species picker: search by name / number / type; a windowed list, so 1038 rows never exist at once; ROM icons painted when a row appears. */
export function openSpeciesPicker(app, { ruleset, current, onPick, title = 'Choose a Pokemon' }) {
  const ROW = 56;
  let ids = [];
  let q = '';
  let active = 0;
  let showAll = false;
  let sortBy = speciesSortPref(), typeF = '';          // the order is remembered (speciesSortPref); the type filter, like the search text, starts empty each time
  const excl = speciesExclusions(app.pack, ruleset);
  const sortName = () => SPECIES_SORTS.find((x) => x[0] === sortBy)[1].toLowerCase();
  const search = h('input', { type: 'search', 'aria-label': 'Search by name, number or type', placeholder: 'Name, #number or type (e.g. "fire flying")', 'data-autofocus': '1', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', dataset: { fk: 'sp-q' } });
  const spacer = h('div', { class: 'spacer' });
  const list = h('div', { class: 'vlist', role: 'listbox', 'aria-label': 'Pokemon', tabindex: '-1' }, spacer);
  const count = h('p', { class: 'dim', role: 'status', 'aria-live': 'polite' });
  const rows = new Map();
  function paint() {
    const top = list.scrollTop, hgt = list.clientHeight || 360;
    const from = Math.max(0, Math.floor(top / ROW) - 4), to = Math.min(ids.length, Math.ceil((top + hgt) / ROW) + 4);
    for (const [i, el] of [...rows]) if (i < from || i >= to) { el.remove(); rows.delete(i); }
    for (let i = from; i < to; i++) {
      if (rows.has(i)) continue;
      const row = speciesRow(app.pack, ids[i], ruleset, excl);
      const sp = app.pack.species[row.id];
      const el = h('button', { type: 'button', class: 'vrow', role: 'option', 'aria-selected': String(row.id === current), 'aria-disabled': row.available ? null : 'true', style: `top:${i * ROW}px;height:${ROW}px`, dataset: { species: row.id, idx: i }, tabindex: i === active ? '0' : '-1' },
        iconEl(app, row.id, { scale: 1 }),
        h('span', { class: 'col' }, h('span', { class: 'nm' }, row.name), h('span', { class: 'sub', title: 'ROM entry ' + row.id }, (row.natDex > 0 ? '#' + row.natDex : 'No Pokedex number') + (row.baseForm ? '' : ' \u00b7 alternate form')), row.available ? null : h('span', { class: 'sub', style: 'color:var(--bad)', dataset: { why: row.code } }, row.text)),
        typeBadges(app, sp, 1));
      el.addEventListener('click', () => { if (!row.available) { app.toast(`${row.name}: ${row.text}`, 'bad'); return; } m.close('pick'); onPick(row.id); });
      list.appendChild(el); rows.set(i, el);
    }
  }
  function refresh() {
    ids = speciesSearch(app.pack, q, ruleset, { unavailable: showAll ? 'last' : 'hide', sort: sortBy, type: typeF });
    const hidden = showAll ? 0 : speciesSearch(app.pack, q, ruleset, { type: typeF }).length - ids.length;
    spacer.style.height = ids.length * ROW + 'px';
    for (const el of rows.values()) el.remove();
    rows.clear();
    active = Math.max(0, ids.indexOf(current));
    list.scrollTop = q ? 0 : Math.max(0, active * ROW - 2 * ROW);
    const how = (typeF ? ', type ' + app.pack.types[Number(typeF)].name : '') + (sortBy !== 'dex' ? ', sorted by ' + sortName() : '');
    count.textContent = (ids.length ? `${ids.length} Pokemon${how}` : 'No Pokemon match that search.') + (hidden ? ` (${hidden} more are left out by these rules)` : '');
    paint();
  }
  let raf = 0;
  list.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); });
  search.addEventListener('input', () => { q = search.value; refresh(); });
  list.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const d = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
    active = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, active + d));
    const need = active * ROW;
    if (need < list.scrollTop) list.scrollTop = need; else if (need + ROW > list.scrollTop + list.clientHeight) list.scrollTop = need + ROW - list.clientHeight;
    paint();
    const el = rows.get(active); if (el) { for (const r of rows.values()) r.tabIndex = -1; el.tabIndex = 0; el.focus({ preventScroll: true }); }
  });
  // Enter in the search box: the species whose whole name was typed, else the first row (see speciesEnterChoice). Under a remembered Type / Name order with several
  // partial hits it picks nothing and says so, rather than add whichever Pokemon that order happens to put first ("abra" is Crabrawler under Type).
  function enterPick() {
    if (!ids.length) return;                                   // the status line already says "No Pokemon match that search."
    const id = speciesEnterChoice(app.pack, ids, q, sortBy);
    if (id === null) { app.toast(`${ids.length} Pokemon match, and the list is sorted by ${sortName()}, so Enter does not choose for you. Pick a row, type the whole name, or sort by Pokedex number.`); return; }
    const r = speciesRow(app.pack, id, ruleset, excl);
    if (!r.available) { app.toast(`${r.name}: ${r.text}`, 'bad'); return; }
    m.close('pick'); onPick(r.id);
  }
  search.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); const el = rows.get(active) || rows.values().next().value; if (el) el.focus(); } if (e.key === 'Enter') enterPick(); });
  const all = h('label', { class: 'inline' }, h('input', { type: 'checkbox', 'aria-label': 'Also list Pokemon these rules leave out', onChange: (e) => { showAll = e.target.checked; refresh(); } }), 'Also list Pokemon these rules leave out (shown disabled, with the reason)');
  // Sort and filter, folded like the move picker's Filters (closed on a phone so the LIST gets the screen)
  const sortSel = h('select', { 'aria-label': 'Sort Pokemon by', dataset: { fk: 'sp-sort' }, onChange: (e) => { sortBy = speciesSortPref(e.target.value); refresh(); } },
    SPECIES_SORTS.map(([v, t]) => h('option', { value: v, selected: v === sortBy }, t)));
  const typeSel = h('select', { 'aria-label': 'Only Pokemon of this type', dataset: { fk: 'sp-type' }, onChange: (e) => { typeF = e.target.value; refresh(); } },
    [h('option', { value: '' }, 'Any type')].concat(speciesTypeChoices(app.pack).map(([id, name]) => h('option', { value: String(id) }, name))));
  // fixed: the sheet does not scroll, the list does (one scrollbar); without it the open Sort and filter block pushed the 52dvh list past the sheet's 86vh cap.
  // bodyClass 'has-vlist' is what editor.css keys the short-window scrolling on (it used to be :has(> .vlist), which a browser without :has() ignored, and which no page test could
  // tell from "any fixed body"); sheetClass 'picker' lets this sheet take the whole height of a short window (editor.css).
  const m = openModal(app, { title, fixed: true, sheetClass: 'picker', bodyClass: 'has-vlist', body: [h('label', null, 'Search', search), fold('Sort and filter', h('div', { class: 'filters' }, h('label', null, 'Sort', sortSel), h('label', null, 'Type', typeSel))), all, count, list] });
  refresh();
  return m;
}

const POWER_RANGES = [['', 'Any power'], ['none', 'No damage'], ['1-50', '1 to 50'], ['51-80', '51 to 80'], ['81-110', '81 to 110'], ['111-', '111 or more']];
const SOURCES = [['', 'Any source'], ['levelUp', 'Level-up'], ['machine', 'TM / HM'], ['tutor', 'Tutor'], ['egg', 'Egg']];
const SORTS = [['name', 'Name'], ['power', 'Power'], ['type', 'Type'], ['level', 'Level learned']];

function moveWhy(app, status) {
  if (status.ok) return '';
  let s = status.text || status.message || status.code;
  if (status.reason) s = `${s}: ${status.reason}.`;
  if (status.why === 'level-too-low' && status.needLevel) s = `${s} It needs level ${status.needLevel}.`;
  return s;
}

/** The move picker: filters (type, category, power, source), sources on every row, unavailable moves shown disabled WITH the rules.js reason. */
export function openMovePicker(app, { mon, ruleset, slot, onPick }) {
  const R = resolveRuleset(ruleset);
  const known = new Set(mon.moves.map((x) => x.id));
  const currentId = mon.moves[slot] ? mon.moves[slot].id : null;
  const cat = moveCatalog(app.pack, mon, R, { allMoves: false });
  let catAll = null;
  const f = { q: '', type: '', category: '', power: '', source: '', sort: 'name', onlyAvailable: false, all: false };
  let shown = 60;
  const sel = (label, key, opts) => h('label', null, label, h('select', { 'aria-label': label, dataset: { fk: 'mv-' + key }, onChange: (e) => { f[key] = e.target.value; shown = 60; draw(); } }, opts.map(([v, t]) => h('option', { value: v, selected: f[key] === v }, t))));
  const typeOpts = [['', 'Any type']].concat(app.pack.types.filter((t) => t.id >= 1 && t.id <= 19 && t.id !== 10).map((t) => [String(t.id), t.name]));
  const search = h('input', { type: 'search', 'aria-label': 'Search moves by name', placeholder: 'Search moves', autocomplete: 'off', 'data-autofocus': '1', dataset: { fk: 'mv-q' }, onInput: (e) => { f.q = e.target.value; shown = 60; draw(); } });
  const listEl = h('div', { class: 'movelist', role: 'list', 'aria-label': 'Moves' });
  const status = h('p', { class: 'dim', role: 'status', 'aria-live': 'polite' });
  const more = h('button', { type: 'button', class: 'btn', onClick: () => { shown += 60; draw(); } }, 'Show more');
  const allToggle = h('label', { class: 'inline' }, h('input', { type: 'checkbox', 'aria-label': 'Include moves this Pokemon cannot learn', onChange: (e) => { f.all = e.target.checked; if (f.all && !catAll) catAll = moveCatalog(app.pack, mon, R, { allMoves: true }); shown = 60; draw(); } }), 'Include moves it cannot learn (shown disabled)');
  const availToggle = h('label', { class: 'inline' }, h('input', { type: 'checkbox', 'aria-label': 'Only moves I can use', onChange: (e) => { f.onlyAvailable = e.target.checked; shown = 60; draw(); } }), 'Only moves I can use');

  function draw() {
    const base = f.all && catAll ? catAll : cat;
    const pr = f.power === 'none' ? { powerMax: 0 } : /^(\d+)-(\d*)$/.exec(f.power) ? { powerMin: Number(RegExp.$1), powerMax: RegExp.$2 === '' ? undefined : Number(RegExp.$2) } : {};
    const rows = filterMoves(base, { q: f.q, type: f.type, category: f.category, source: f.source, sort: f.sort, onlyAvailable: f.onlyAvailable, ...pr });
    const usable = rows.filter((r) => r.status.ok).length;
    status.textContent = `${rows.length} move${rows.length === 1 ? '' : 's'}, ${usable} you can use${rows.length > shown ? '; showing ' + shown : ''}`;
    put(listEl, rows.slice(0, shown).map((r) => {
      const dup = known.has(r.id) && r.id !== currentId;
      const ok = r.status.ok && !dup;
      const why = dup ? 'This Pokemon already knows this move.' : moveWhy(app, r.status);
      const id = uid('mv');
      const el = h('button', { type: 'button', class: 'mvrow', role: 'listitem', 'aria-disabled': ok ? null : 'true', 'aria-pressed': String(r.id === currentId), 'aria-describedby': ok ? null : id, dataset: { move: r.id } },
        h('span', { class: 'tp' }, typeBadgeEl(app, r.type)), h('span', { class: 'nm' }, r.name),
        h('span', { class: 'st' }, `${r.category === 2 ? '\u2014' : r.power || '\u2014'} pwr \u00b7 ${r.accuracy ? r.accuracy + '%' : '\u2014'} \u00b7 ${r.pp} PP`),
        h('span', { class: 'ct' }, categoryEl(app, r.category)), h('span', { class: 'ds' }, r.desc),
        h('span', { class: 'tg' }, r.tags.map((t) => h('span', { class: 'tag ' + t.kind }, t.label)), !r.learnable ? h('span', { class: 'tag' }, 'cannot learn') : null, ok ? null : h('span', { class: 'why', id }, why)));
      el.addEventListener('click', () => { if (!ok) { app.toast(why, 'bad'); return; } m.close('pick'); onPick(r.id); });
      return el;
    }), rows.length > shown ? more : null);
  }
  const m = openModal(app, {
    title: `Move ${slot + 1}: ${speciesName(app, mon.species)}`,
    fixed: true,
    body: [h('label', null, 'Search', search),
      fold('Filters and options', h('div', { class: 'filters' }, sel('Type', 'type', typeOpts), sel('Category', 'category', [['', 'Any'], ['0', 'Physical'], ['1', 'Special'], ['2', 'Status']]), sel('Power', 'power', POWER_RANGES), sel('Source', 'source', SOURCES), sel('Sort', 'sort', SORTS)),
        h('div', { class: 'row' }, availToggle, allToggle)), status, listEl],
  });
  draw();
  return m;
}

export function openItemPicker(app, { ruleset, current, onPick }) {
  const R = resolveRuleset(ruleset);
  const f = { q: '', holdOnly: true, all: false };
  let shown = 80;
  const search = h('input', { type: 'search', 'aria-label': 'Search items', placeholder: 'Search by name or effect', autocomplete: 'off', 'data-autofocus': '1', dataset: { fk: 'it-q' }, onInput: (e) => { f.q = e.target.value; shown = 80; draw(); } });
  const list = h('div', { class: 'movelist', role: 'list', 'aria-label': 'Held items' });
  const status = h('p', { class: 'dim', role: 'status', 'aria-live': 'polite' });
  const hold = h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: true, 'aria-label': 'Only items with a hold effect', onChange: (e) => { f.holdOnly = e.target.checked; shown = 80; draw(); } }), 'Only items with a hold effect');
  const more = h('button', { type: 'button', class: 'btn', onClick: () => { shown += 80; draw(); } }, 'Show more');
  const allToggle = h('label', { class: 'inline' }, h('input', { type: 'checkbox', 'aria-label': 'Also list items these rules leave out', onChange: (e) => { f.all = e.target.checked; shown = 80; draw(); } }), 'Also list items these rules leave out (shown disabled, with the reason)');
  function draw() {
    const cat = itemCatalog(app.pack, R, { holdEffectOnly: f.holdOnly, q: f.q });
    const rows = f.all ? cat : cat.filter((x) => x.status.ok);
    const hiddenN = cat.length - rows.length;
    status.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}${rows.length > shown ? '; showing ' + shown : ''}${hiddenN ? ` (${hiddenN} more are left out by these rules)` : ''}`;
    const none = h('button', { type: 'button', class: 'pick', 'aria-pressed': String(current === 0), dataset: { item: 0 }, onClick: () => { m.close('pick'); onPick(0); } }, h('span', { class: 't' }, 'No item'), h('span', { class: 'd' }, 'The Pokemon holds nothing.'));
    put(list, none, rows.slice(0, shown).map((it) => {
      const ok = it.status.ok; const id = uid('it');
      const el = h('button', { type: 'button', class: 'pick', role: 'listitem', 'aria-pressed': String(it.id === current), 'aria-disabled': ok ? null : 'true', 'aria-describedby': ok ? null : id, dataset: { item: it.id } },
        h('span', { class: 't' }, it.name), h('span', { class: 'd', style: 'white-space:pre-line' }, it.desc || ''), ok ? null : h('span', { class: 'd', id, style: 'color:var(--bad);font-weight:600' }, it.status.reason ? `${it.status.text}: ${it.status.reason}.` : it.status.text));
      el.addEventListener('click', () => { if (!ok) { app.toast(it.status.reason ? `${it.status.text}: ${it.status.reason}.` : it.status.text, 'bad'); return; } m.close('pick'); onPick(it.id); });
      return el;
    }), rows.length > shown ? more : null);
  }
  const m = openModal(app, { title: 'Held item', fixed: true, body: [h('label', null, 'Search', search), fold('Options', h('div', { class: 'row' }, hold, allToggle)), status, list] });
  draw();
  return m;
}

export function openAvatarPicker(app, { current, onPick }) {
  const grid = h('div', { class: 'avatars', role: 'group', 'aria-label': 'Trainer portraits' });
  for (let i = 0; i < AVATAR_PRESETS; i++) {
    const b = h('button', { type: 'button', 'aria-label': 'Portrait ' + (i + 1), 'aria-pressed': String(current.kind === 'preset' && current.id === i), dataset: { avatar: i }, onClick: () => { m.close('pick'); onPick({ kind: 'preset', id: i }); } }, artEl(app.art.trainerHead(i), 1, ''));
    grid.appendChild(b);
  }
  const m = openModal(app, { title: 'Choose a portrait', body: [h('p', { class: 'dim' }, 'These are the trainer portraits stored in the ROM.'), grid] });
  return m;
}

/* ================================================================================================ the profile screen */

const fmtTime = (ts) => { try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_e) { return String(ts); } };
const fp = (keyId) => String(keyId || '').match(/.{1,4}/g)?.join(' ') || '';

export function profilesView(app) {
  const el = h('section', { class: 'screen', 'aria-labelledby': 'h-profiles' });
  const importState = { result: null, busy: false };
  let identity = { state: 'loading' };
  const draw = () => rebuild(el, () => {
    const st = app.state, active = st ? st.profile : null, status = app.storeStatus();
    const kids = [h('h2', { id: 'h-profiles', tabindex: '-1' }, 'Profiles')];

    // the list
    const list = h('div', { class: 'stack', role: 'list', 'aria-label': 'Your profiles' });
    for (const p of app.profiles) {
      const isActive = !!active && p.id === active.id;
      const live = isActive ? { teams: active.teams.length, mons: active.box.length, name: active.trainerName, avatar: active.avatar } : p;
      const av = live.avatar && live.avatar.kind === 'preset' ? live.avatar.id : 0;
      list.appendChild(h('div', { class: 'card item-card', role: 'listitem', dataset: { profile: p.id, active: String(isActive) } },
        h('div', { class: 'head' }, artEl(app.art.trainerHead(av % AVATAR_PRESETS), 1, ''),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, live.name || p.trainerName || '(unreadable)'),
            h('div', { class: 'dim' }, `${live.teams === undefined ? '?' : live.teams} team${live.teams === 1 ? '' : 's'} \u00b7 ${live.mons === undefined ? '?' : live.mons} Pokemon`, p.updatedAt ? ` \u00b7 saved ${fmtTime(p.updatedAt)}` : ''),
            isActive ? h('span', { class: 'badge good' }, 'Active') : null, p.readOnly ? h('span', { class: 'badge warn' }, 'newer version: read-only') : null)),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', 'data-nav-default': app.profiles[0] === p ? true : null, dataset: { act: 'open' }, onClick: () => app.actions.openProfile(p.id) }, isActive ? 'Open teams' : 'Switch to this profile'),
          isActive ? h('button', { type: 'button', class: 'btn', dataset: { act: 'avatar' }, onClick: () => openAvatarPicker(app, { current: active.avatar, onPick: (a) => app.dispatch({ type: 'avatar', ...a }) }) }, 'Portrait') : null,
          h('button', { type: 'button', class: 'btn', dataset: { act: 'rename' }, onClick: () => renameDialog(app, p, live.name) }, 'Rename'),
          h('button', { type: 'button', class: 'btn', dataset: { act: 'export' }, onClick: () => app.actions.exportProfile(p.id) }, 'Export'),
          h('button', { type: 'button', class: 'btn danger', dataset: { act: 'delete' }, onClick: () => deleteProfileDialog(app, p, live.name) }, 'Delete'))));
    }
    if (!app.profiles.length) list.appendChild(h('div', { class: 'card' }, h('p', null, 'No profile yet. A profile keeps your teams in this browser (nothing is sent anywhere). Make one to start.')));
    kids.push(list);

    // new profile
    const nameIn = h('input', { type: 'text', 'aria-label': 'New profile name', maxlength: String(PROFILE_LIMITS.trainerName), placeholder: 'Trainer name', autocomplete: 'off', dataset: { fk: 'new-name' }, value: el._newName || '' });
    nameIn.addEventListener('input', () => { el._newName = nameIn.value; });
    const err = h('div', { class: 'field-error', role: 'alert' }, el._newErr || '');
    const create = async () => { const r = await app.actions.createProfile(nameIn.value || 'TRAINER'); if (!r.ok) { el._newErr = r.message; draw(); } else { el._newName = ''; el._newErr = ''; } };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    kids.push(h('div', { class: 'card stack' }, h('h3', null, 'New profile'), h('label', null, 'Trainer name (up to 10 characters)', nameIn), err,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', dataset: { act: 'create' }, onClick: create }, 'Create profile'))));

    // import a SoulGold save (its own screen)
    kids.push(h('div', { class: 'card stack' }, h('h3', null, 'Import from a SoulGold save'), h('p', { class: 'dim' }, 'Bring Pokemon from your own save file (.sav) into a team. You do not need a profile first.'), h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', dataset: { act: 'import-save' }, onClick: () => app.navigate({ name: 'import' }) }, 'Import from a save'))));

    // import
    const file = h('input', { type: 'file', accept: '.json,.gz,application/json,application/gzip', 'aria-label': 'Choose a .pokemonarena.json profile file', dataset: { fk: 'import-file', importFile: '1' } });
    file.addEventListener('change', async () => { const f = file.files && file.files[0]; if (!f) return; importState.busy = true; importState.result = null; draw(); importState.result = await app.actions.readImportFile(f); importState.busy = false; draw(); });
    const res = importState.result;
    const resBox = importState.busy ? h('p', { role: 'status' }, 'Reading the file...') : !res ? null : res.ok ? importPreview(app, res, importState, () => draw()) :
      h('div', { class: 'banner bad', role: 'alert', dataset: { importError: res.code } }, h('strong', null, 'This file was not imported'), res.message,
        res.hint ? h('div', { class: 'dim' }, res.hint) : null,
        res.code === 'import.checksum' ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn danger', dataset: { act: 'import-anyway' }, onClick: async () => { importState.busy = true; draw(); importState.result = await app.actions.readImportFile(res.file, { allowChecksumMismatch: true }); importState.busy = false; draw(); } }, 'Import anyway (the file may have been edited)')) : null);
    kids.push(h('div', { class: 'card stack' }, h('h3', null, 'Import a profile'), h('p', { class: 'dim' }, 'A .pokemonarena.json file from the Export button. The file is checked (size, checksum, ROM, contents) before anything changes.'), h('label', null, 'Profile file', file), resBox));

    // identity
    if (active) kids.push(identityCard(app, identity, active, () => refreshIdentity()));

    // storage
    kids.push(h('div', { class: 'card stack' }, h('h3', null, 'Where your data lives'),
      h('p', null, status.mode === 'indexeddb' && !status.notSaved ? 'Profiles are saved in this browser (IndexedDB) after every edit. Nothing leaves your device.' : 'This browser is NOT saving profiles: ' + (status.reason || 'storage is unavailable') + '. Edits live in memory until you Export.'),
      h('p', { class: 'dim' }, status.persistence && status.persistence.granted ? 'The browser has promised not to clear this data under storage pressure.' : 'The browser may clear this data if it runs low on space or if you clear site data. Export a backup now and then.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', dataset: { act: 'persist' }, onClick: () => app.actions.requestPersistence() }, 'Ask the browser to keep my data'))));

    // danger
    kids.push(h('div', { class: 'card stack' }, h('h3', null, 'Delete everything'), h('p', { class: 'dim' }, 'Removes every profile, team, Pokemon, backup and identity key stored by this page in this browser. Export first if you want to keep anything.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn danger', dataset: { act: 'delete-all' }, onClick: () => deleteEverythingDialog(app) }, 'Delete everything...'))));
    kids.push(aboutCard());
    return kids;
  });
  let lastProfile = null;
  async function refreshIdentity() { identity = await app.actions.identityStatus(); draw(); }
  // the identity belongs to the ACTIVE profile: when that changes, the cached status is stale
  const update = () => { const id = app.state ? app.state.profile.id : null; if (id !== lastProfile) { lastProfile = id; identity = { state: 'loading' }; if (id) refreshIdentity(); } draw(); };
  update();
  return { el, update, refreshIdentity };
}

function aboutCard() {
  return h('details', { class: 'card', dataset: { about: '1' } }, h('summary', { style: 'min-height:44px;display:flex;align-items:center;cursor:pointer' }, 'About this editor'),
    h('ul', { class: 'dim' },
      h('li', null, 'Every picture (party icons, sprites, type badges, move-category icons, stat bars, arrows, portraits) is decoded from the Pokemon SoulGold v1.1.1 ROM this site already serves. Nothing ROM-derived is stored or sent.'),
      h('li', null, 'The held-item list defaults to items with a hold effect (388 of 930). Untick it to see every item.'),
      h('li', null, 'Forms: battle-only forms (Mega and the like) are ordinary roster entries; they are listed with "form" next to their Pokedex number.')));
}

function renameDialog(app, p, name) {
  const input = h('input', { type: 'text', value: name || '', maxlength: String(PROFILE_LIMITS.trainerName), 'aria-label': 'Profile name', 'data-autofocus': '1', dataset: { fk: 'rename-in' } });
  const err = h('div', { class: 'field-error', role: 'alert' });
  const go = async () => { const r = await app.actions.renameProfile(p.id, input.value); if (r.ok) m.close('ok'); else err.textContent = r.message; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  const m = openModal(app, { title: 'Rename profile', body: [h('label', null, 'Name (up to 10 characters)', input), err], footer: [h('button', { type: 'button', class: 'btn', onClick: () => m.close('cancel') }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', dataset: { act: 'rename-ok' }, onClick: go }, 'Rename')] });
}
async function deleteProfileDialog(app, p, name) {
  const yes = await confirmDialog(app, { title: 'Delete this profile?', message: [`"${name || p.trainerName}" and all of its teams and Pokemon will be removed from this browser. This cannot be undone.`, 'Tip: Export it first if you might want it back.'], confirmLabel: 'Delete profile', danger: true });
  if (yes) await app.actions.deleteProfile(p.id);
}
async function deleteEverythingDialog(app) {
  const yes = await confirmDialog(app, { title: 'Delete everything?', message: ['This removes EVERY profile, team, Pokemon, automatic backup and identity key from this browser. It cannot be undone.', 'Teams you shared as codes, and files you exported, are not affected.'], confirmLabel: 'Delete everything', danger: true, requireText: 'DELETE' });
  if (yes) await app.actions.deleteEverything();
}

function recordNote(p, mode) {
  const n = p.stats ? (p.stats.wins | 0) + (p.stats.losses | 0) + (p.stats.draws | 0) + (p.stats.forfeits | 0) : 0;
  const battles = n + ' battle' + (n === 1 ? '' : 's');
  if (mode === 'replace') return n ? `The battle record is replaced too: the file's (${battles}) takes its place, and the backup keeps the old one.` : 'The battle record is replaced too: the file has none, so it is cleared (the backup keeps the old one).';
  if (mode === 'merge') return n ? `The active profile's battle record is left exactly as it is; the file's (${battles}) is not added.` : "The active profile's battle record is left exactly as it is.";
  return n ? `Its battle record (${battles}) comes with it.` : 'Its battle record is empty.';
}

// schema 5: the Pokemon Tower's climb (profile.tower) travels like the battle record: new = the file's comes along, merge = the active profile's is left exactly as it is, replace = the file's takes its place
function towerNote(p, mode) {
  const t = p.tower, n = t ? t.runs | 0 : 0, best = t && t.best ? Math.max(t.best['3v3'] | 0, t.best['6v6'] | 0) : 0;
  const climb = n ? `${n} Tower run${n === 1 ? '' : 's'}, best floor ${best}` : 'no Tower runs';
  if (mode === 'replace') return `The Tower climb is replaced too: the file's (${climb}) takes its place, and the backup keeps the old one.`;
  if (mode === 'merge') return "The active profile's Tower climb is left exactly as it is; the file's is not added.";
  return `Its Tower climb (${climb}) comes with it.`;
}

function importPreview(app, res, importState, redraw) {
  const p = res.profile;
  const active = app.state ? app.state.profile : null;
  const mode = importState.mode || 'new';
  const rules = res.rules;
  const bad = rules && !rules.ok ? rules.teams.filter((t) => !t.ok).length : 0;
  const choose = (m) => { importState.mode = m; redraw(); };
  return h('div', { class: 'card stack', dataset: { importPreview: '1' } },
    h('h3', null, `Ready to import "${p.trainerName}"`),
    h('p', null, `${p.teams.length} team${p.teams.length === 1 ? '' : 's'}, ${p.box.length} Pokemon.${res.migratedFrom ? ' (An older file format; it was converted.)' : ''} Checksum ${res.checksum === 'ok' ? 'matches' : 'OVERRIDDEN'}.`),
    bad ? h('p', { class: 'dim' }, `${bad} team${bad === 1 ? ' does' : 's do'} not pass the rules for ${bad === 1 ? 'its' : 'their'} ruleset; they import as they are and are flagged in the team list.`) : null,
    res.quarantined && res.quarantined.length ? h('p', { class: 'banner warn' }, `${res.quarantined.length} damaged record${res.quarantined.length === 1 ? ' was' : 's were'} set aside and not imported.`) : null,
    segmented([{ value: 'new', label: 'As a new profile' }, { value: 'merge', label: 'Merge into the active one', disabled: !active }, { value: 'replace', label: 'Replace the active one', disabled: !active }], { label: 'Import mode', current: mode, onPick: choose }),
    mode === 'replace' ? h('p', { class: 'dim' }, 'Replace keeps your current identity key and takes a backup of what it replaces.') : mode === 'merge' ? h('p', { class: 'dim' }, 'Merge adds the file\'s Pokemon and teams to the active profile; duplicates are skipped.') : h('p', { class: 'dim' }, 'A new profile gets a new id. Its identity is the public key only; this browser holds no private key for it.'),
    // ST1: what the import does with the BATTLE RECORD (profile.stats): new = the file's comes along, merge = the active profile's is left exactly as it is, replace = the file's takes its place
    h('p', { class: 'dim', dataset: { importRecord: mode } }, recordNote(p, mode)),
    h('p', { class: 'dim', dataset: { importTower: mode } }, towerNote(p, mode)),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', dataset: { act: 'import-apply' }, onClick: async () => { const r = await app.actions.applyImport(res, mode); if (r.ok) { importState.result = null; importState.mode = null; } else importState.result = { ok: false, code: r.code || 'import.apply', message: r.message }; redraw(); } }, 'Import'),
      h('button', { type: 'button', class: 'btn', onClick: () => { importState.result = null; redraw(); } }, 'Cancel')));
}

function identityCard(app, identity, profile, refresh) {
  const caps = app.caps;
  const st = identity.state;
  const lines = [];
  if (!caps.webcrypto) lines.push(h('p', { class: 'banner warn' }, 'This browser has no WebCrypto here (it needs https or localhost), so identity keys are off. Teams and profiles still work.'));
  else if (st === 'loading') lines.push(h('p', { class: 'dim' }, 'Checking...'));
  else if (st === 'none') lines.push(h('p', null, 'This profile has no identity key yet. A key lets other players recognise you across matches without an account.'));
  else {
    lines.push(h('p', null, 'Key fingerprint ', h('code', { dataset: { fingerprint: identity.keyId || '' } }, fp(identity.keyId)), ' ', h('span', { class: 'badge ' + (st === 'ok' ? 'good' : 'warn') }, { ok: 'key present', ephemeral: 'key present, not durable', 'no-key': 'no private key in this browser', mismatch: 'key does not match', unusable: 'key unusable', invalid: 'key invalid' }[st] || st)));
    if (st === 'no-key') lines.push(h('p', { class: 'banner warn' }, 'This profile came from a file, so this browser holds no private key for it. Making a new identity keeps the old public key in the profile as retired.'));
    if (st === 'ephemeral') lines.push(h('p', { class: 'banner warn' }, 'Storage is not durable right now, so this key will be lost when the page closes.'));
  }
  lines.push(h('p', { class: 'dim' }, IDENTITY_NOTICE));
  lines.push(h('p', { class: 'banner warn', dataset: { keyLoss: '1' } }, h('strong', null, 'If you lose this key you lose this identity.'), 'The private key lives only in this browser. Clearing site data, using another browser, or "Delete everything" removes it for good; Export does not include it.'));
  const row = [];
  if (caps.webcrypto && st === 'none') row.push(h('button', { type: 'button', class: 'btn primary', dataset: { act: 'identity-create' }, onClick: async () => { await app.actions.createIdentity(); refresh(); } }, 'Create identity'));
  if (caps.webcrypto && st !== 'none' && st !== 'loading') row.push(h('button', { type: 'button', class: 'btn danger', dataset: { act: 'identity-rotate' }, onClick: async () => { const yes = await confirmDialog(app, { title: 'Replace your identity key?', message: ['A new key replaces the current one. The old public key is kept in this profile as retired, but this browser can no longer sign as it.', 'Anyone who knows your old key will not recognise the new one.'], confirmLabel: 'Replace key', danger: true }); if (yes) { await app.actions.rotateIdentity(); refresh(); } } }, 'Replace identity key...'));
  return h('div', { class: 'card stack', dataset: { identity: st } }, h('h3', null, 'Identity key'), ...lines, row.length ? h('div', { class: 'row' }, row) : null);
}

/* ================================================================================================ the team list */

export function teamsView(app) {
  const el = h('section', { class: 'screen', 'aria-labelledby': 'h-teams' });
  const draw = () => rebuild(el, () => {
    const P = app.state.profile;
    const kids = [h('div', { class: 'spread' }, h('h2', { id: 'h-teams', tabindex: '-1' }, P.trainerName + "'s teams"), h('span', { class: 'dim', role: 'status' }, `${P.teams.length} of ${EDITOR_LIMITS.teamsMax}`))];
    const list = h('div', { class: 'stack', role: 'list', 'aria-label': 'Teams' });
    P.teams.forEach((t, i) => {
      const mons = teamMonsOf(P, t.id);
      const v = validationView(app.pack, mons, t.ruleset);
      list.appendChild(h('div', { class: 'card item-card', role: 'listitem', dataset: { team: t.id } },
        h('div', { class: 'head' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, t.name), h('div', { class: 'dim' }, rulesetLabel(t.ruleset))),
          h('span', { class: 'badge ' + (mons.length && v.ok ? 'good' : 'bad'), dataset: { validity: v.ok ? 'ok' : 'bad' } }, !mons.length ? 'Empty' : v.ok ? 'Legal' : `${v.count} problem${v.count === 1 ? '' : 's'}`)),
        h('div', { class: 'minis', 'aria-label': `${mons.length} Pokemon` }, mons.map((m) => iconEl(app, m.species, { scale: 2, shiny: m.shiny })), !mons.length ? h('span', { class: 'dim' }, 'No Pokemon yet') : null),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', 'data-nav-default': i === 0 ? true : null, dataset: { act: 'open-team' }, onClick: () => app.navigate({ name: 'team', teamId: t.id }) }, 'Open'),
          h('button', { type: 'button', class: 'btn', dataset: { act: 'dup-team' }, disabled: P.teams.length >= EDITOR_LIMITS.teamsMax, onClick: () => app.dispatch({ type: 'teamDuplicate', teamId: t.id }) }, 'Duplicate'),
          h('button', { type: 'button', class: 'btn', 'aria-label': `Move ${t.name} up`, disabled: i === 0, dataset: { act: 'team-up' }, onClick: () => app.dispatch({ type: 'teamMove', teamId: t.id, to: i - 1 }) }, 'Up'),
          h('button', { type: 'button', class: 'btn', 'aria-label': `Move ${t.name} down`, disabled: i === P.teams.length - 1, dataset: { act: 'team-down' }, onClick: () => app.dispatch({ type: 'teamMove', teamId: t.id, to: i + 1 }) }, 'Down'),
          h('button', { type: 'button', class: 'btn danger', dataset: { act: 'delete-team' }, onClick: async () => { if (await confirmDialog(app, { title: 'Delete this team?', message: `"${t.name}" and its ${mons.length} Pokemon will be deleted. You can undo this right after.`, confirmLabel: 'Delete team', danger: true })) app.dispatch({ type: 'teamDelete', teamId: t.id }); } }, 'Delete'))));
    });
    if (!P.teams.length) list.appendChild(h('div', { class: 'card' }, h('p', null, 'No teams yet. Create one, add up to six Pokemon, and give each its nature, moves and spread.')));
    kids.push(list);
    const full = P.teams.length >= EDITOR_LIMITS.teamsMax;
    kids.push(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', 'data-nav-default': P.teams.length ? null : true, dataset: { act: 'new-team' }, disabled: full, onClick: () => { const r = app.dispatch({ type: 'teamCreate' }); if (r && r.result && r.result.teamId) app.navigate({ name: 'team', teamId: r.result.teamId }); } }, full ? 'Team limit reached' : 'New team'),
      h('button', { type: 'button', class: 'btn', dataset: { act: 'import-code' }, disabled: full, onClick: () => openImportCode(app) }, 'Import a team code'),
      h('button', { type: 'button', class: 'btn', dataset: { act: 'import-save' }, onClick: () => app.navigate({ name: 'import' }) }, 'Import from a save')));
    const unused = unusedMons(P);
    if (unused.length) kids.push(h('div', { class: 'banner info' }, `${unused.length} Pokemon in your box are on no team (they came from an import).`, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onClick: () => app.dispatch({ type: 'boxCleanup' }) }, 'Remove them'))));
    return kids;
  });
  draw();
  return { el, update: draw };
}

function openImportCode(app) {
  const area = h('textarea', { 'aria-label': 'Paste a team code', placeholder: 'ARENA1.xxxxxxxx.xxxx', rows: '4', spellcheck: 'false', autocomplete: 'off', 'data-autofocus': '1', dataset: { fk: 'code-in' } });
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  let decoded = null;
  const add = h('button', { type: 'button', class: 'btn primary', disabled: true, dataset: { act: 'code-add' }, onClick: () => { const r = app.dispatch({ type: 'teamImport', team: decoded }); if (r && r.result && r.result.teamId) { m.close('ok'); app.navigate({ name: 'team', teamId: r.result.teamId }); } } }, 'Add as a new team');
  const check = async () => {
    decoded = null; add.disabled = true;
    const text = area.value;
    if (!text.trim()) { out.replaceChildren(); return; }
    let r;
    try { r = await app.actions.decodeCode(text); } catch (e) { r = { ok: false, code: 'code.internal', message: 'The code could not be read: ' + (e && e.message ? e.message : e) }; }
    if (text !== area.value) return;                          // the player kept typing; a newer check is on its way
    if (!r.ok) { out.replaceChildren(h('div', { class: 'banner bad', role: 'alert', dataset: { codeError: r.code } }, h('strong', null, 'That code cannot be used'), r.message, h('div', { class: 'dim' }, r.code))); return; }
    decoded = r.team;
    const v = r.validation;
    out.replaceChildren(h('div', { class: 'card stack', dataset: { codePreview: '1' } }, h('div', null, h('strong', null, r.team.name || '(unnamed team)'), ` \u00b7 ${rulesetLabel(r.team.ruleset)}`),
      h('div', { class: 'minis' }, r.team.mons.map((m) => iconEl(app, m.species, { scale: 2 }))),
      v.ok ? h('p', { class: 'ok-line' }, 'Every Pokemon passes the rules.') : h('p', { class: 'dim' }, `${v.count} problem${v.count === 1 ? '' : 's'} under its rules; it imports as it is and the team screen lists them.`)));
    add.disabled = false;
  };
  area.addEventListener('input', check);
  area.addEventListener('paste', () => setTimeout(check, 0));
  const m = openModal(app, { title: 'Import a team code', body: [h('p', { class: 'dim' }, 'Paste a code that starts with ARENA1. It is checked for typos, the ROM and the rules before anything is added.'), area, out], footer: [h('button', { type: 'button', class: 'btn', onClick: () => m.close('cancel') }, 'Cancel'), add] });
}

/* ================================================================================================ one team */

export function teamView(app, teamId) {
  const el = h('section', { class: 'screen', 'aria-labelledby': 'h-team' });
  let codeState = { key: null, code: null, error: null, busy: false };
  let foeId = '', fmt = null, cpu = 'normal';
  const draw = () => rebuild(el, () => {
    const P = app.state.profile;
    const team = findTeam(P, teamId);
    if (!team) return [h('div', { class: 'card' }, h('p', null, 'That team does not exist (any more).'), h('button', { type: 'button', class: 'btn primary', onClick: () => app.navigate({ name: 'teams' }) }, 'Back to my teams'))];
    const R = resolveRuleset(team.ruleset);
    const mons = teamMonsOf(P, teamId);
    const v = validationView(app.pack, mons, team.ruleset);
    const kids = [];
    // name
    const nameIn = h('input', { type: 'text', value: team.name, maxlength: String(PROFILE_LIMITS.teamName), 'aria-label': 'Team name', dataset: { fk: 'team-name' }, autocomplete: 'off' });
    nameIn.addEventListener('change', () => { const r = app.dispatch({ type: 'teamRename', teamId, name: nameIn.value }); if (r.error) nameIn.value = team.name; });
    kids.push(h('div', { class: 'spread' }, h('h2', { id: 'h-team', tabindex: '-1' }, 'Team'), h('span', { class: 'badge ' + (mons.length && v.ok ? 'good' : 'bad'), dataset: { validity: v.ok && mons.length ? 'ok' : 'bad' } }, !mons.length ? 'Empty' : v.ok ? 'Legal' : `${v.count} problem${v.count === 1 ? '' : 's'}`)));
    kids.push(h('label', null, 'Team name', nameIn));

    // slots
    const slots = h('div', { class: 'slots', role: 'list', 'aria-label': 'Team members' });
    const max = Math.min(R.team.max, EDITOR_LIMITS.teamSize);
    mons.forEach((m, i) => {
      const sp = app.pack.species[m.species] || null;
      const spName = speciesName(app, m.species);
      const mv = monProblems(app.pack, m, team.ruleset);
      slots.appendChild(h('div', { class: 'slot', role: 'listitem', dataset: { mon: m.id } },
        h('button', { type: 'button', class: 'open', 'data-nav-default': i === 0 ? true : null, 'aria-label': `Edit ${m.nickname || spName}`, dataset: { act: 'open-mon' }, onClick: () => app.navigate({ name: 'mon', teamId, monId: m.id, tab: 'build' }) },
          iconEl(app, m.species, { scale: 2, shiny: m.shiny }), h('span', { class: 'meta' }, h('span', { class: 'name' }, m.nickname || spName), h('span', { class: 'dim', dataset: { lv: String(m.level) } }, `Lv ${m.level}`, R.level.battle !== null && R.level.battle !== m.level ? ` (fights at Lv ${R.level.battle})` : ''), typeBadges(app, sp, 1))),
        h('span', { class: 'badge ' + (mv.ok ? 'good' : 'bad') }, mv.ok ? 'OK' : `${mv.problems.length} problem${mv.problems.length === 1 ? '' : 's'}`),
        h('div', { class: 'acts' },
          h('button', { type: 'button', class: 'btn small', 'aria-label': `Move ${spName} earlier`, disabled: i === 0, dataset: { act: 'mon-left' }, onClick: () => app.dispatch({ type: 'monMove', teamId, monId: m.id, to: i - 1 }) }, '\u25c0'),
          h('button', { type: 'button', class: 'btn small', 'aria-label': `Move ${spName} later`, disabled: i === mons.length - 1, dataset: { act: 'mon-right' }, onClick: () => app.dispatch({ type: 'monMove', teamId, monId: m.id, to: i + 1 }) }, '\u25b6'),
          h('button', { type: 'button', class: 'btn small', 'aria-label': `Copy ${spName}`, disabled: mons.length >= max, dataset: { act: 'mon-copy' }, onClick: () => app.dispatch({ type: 'monDuplicate', teamId, monId: m.id }) }, 'Copy'),
          h('button', { type: 'button', class: 'btn small danger', 'aria-label': `Remove ${spName}`, dataset: { act: 'mon-remove' }, onClick: () => app.dispatch({ type: 'monRemove', teamId, monId: m.id }) }, 'Remove'))));
    });
    if (mons.length < max) slots.appendChild(h('div', { class: 'slot empty', role: 'listitem' }, h('button', { type: 'button', class: 'btn primary', 'data-nav-default': mons.length ? null : true, dataset: { act: 'add-mon' }, onClick: () => openSpeciesPicker(app, { ruleset: team.ruleset, onPick: (id) => { const r = app.dispatch({ type: 'monAdd', teamId, species: id }); if (r.result && r.result.monId) app.navigate({ name: 'mon', teamId, monId: r.result.monId, tab: 'build' }); } }) }, mons.length ? '+ Add a Pokemon' : '+ Add your first Pokemon'), h('span', { class: 'dim' }, `${mons.length} of ${max}`)));
    kids.push(slots);
    if (mons.length > 1) {
      const cmp = speciesComparator(app.pack, 'type');
      const inOrder = mons.every((m, i) => i === 0 || cmp(mons[i - 1].species, m.species) <= 0);
      // Once the team is in order the button is aria-disabled, NOT disabled: a disabled button cannot hold focus, so the person who pressed it (keyboard or pad) would be
      // thrown to the top of the page, and could never reach the reason. Pressed again it does nothing but say "already sorted" in the live region (the reducer's notice).
      // data-fk lets rebuild() hand focus to the new button when the view is redrawn (the sort itself, then the team code arriving).
      kids.push(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', 'aria-disabled': inOrder ? 'true' : null, dataset: { act: 'sort-team-type', fk: 'sort-team-type' },
        title: inOrder ? 'Already in type order' : 'Put the team in type order: Normal, Fighting, Flying ... as the game lists the types. This is the order of the slots: in a 6v6 battle the first Pokemon leads, in 3v3 you choose the lead at team preview. You can undo it.',
        onClick: () => app.dispatch({ type: 'teamSort', teamId, by: 'type' }) }, 'Sort team by type')));
    }

    // validation
    kids.push(h('div', { class: 'card', 'aria-live': 'polite', role: 'status', dataset: { teamValidation: v.ok ? 'ok' : 'bad' } }, h('h3', null, 'Does it pass the rules?'),
      !mons.length ? h('p', { class: 'dim' }, 'Add a Pokemon to check it.') : v.ok ? h('p', { class: 'ok-line' }, `Yes. Every Pokemon passes ${rulesetLabel(team.ruleset)}.`) : [
        v.team.length ? problemList(app, v.team, { heading: 'Team problems' }) : null,
        ...v.mons.map((ps, i) => ps.length ? h('div', null, h('h4', { style: 'margin:8px 0 4px;font-size:14px' }, `${mons[i].nickname || speciesName(app, mons[i].species)} (slot ${i + 1})`), problemList(app, ps)) : null),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', dataset: { act: 'conform' }, onClick: () => app.dispatch({ type: 'teamConform', teamId }) }, 'Convert team to these rules'), h('span', { class: 'dim' }, 'Fixes levels, IVs, EVs, abilities, items and illegal moves where the rules say how; you can undo it.'))]));

    // rules panel
    const parsed = parseRulesetId(team.ruleset);
    const setRules = (patch) => app.dispatch({ type: 'teamRuleset', teamId, ruleset: buildRulesetId({ ...parsed, keep: parsed.unknown, ...patch }) });
    kids.push(h('div', { class: 'card stack', dataset: { rulesPanel: team.ruleset } }, h('h3', null, 'Rules'),
      h('div', { role: 'radiogroup', 'aria-label': 'Level and stat rules', class: 'stack' }, LEVEL_MODES.map((mode) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'mode', value: mode, checked: parsed.mode === mode, 'aria-label': rulesetLabel(buildRulesetId({ mode })), dataset: { fk: 'mode-' + mode }, onChange: () => setRules({ mode }) }), { standard: 'Standard: battles at Lv 50, 510 EVs', lv5: 'Level 5 battles', lv100: 'Level 100 battles', 'strict-champions': 'Champions: Lv 50, IV 31, stat points (66)' }[mode]))),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: parsed.itemClause, dataset: { fk: 'item-clause' }, onChange: (e) => setRules({ itemClause: e.target.checked }) }), 'Item clause: no two Pokemon hold the same item'),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: parsed.noSpeciesClause, dataset: { fk: 'dupes' }, onChange: (e) => setRules({ noSpeciesClause: e.target.checked }) }), 'Allow two of the same Pokedex number'),
      h('p', { class: 'dim' }, 'Changing the rules does not edit any Pokemon. If something no longer fits, the problems are listed above and "Convert team" fixes them.')));

    // share + test battle
    kids.push(shareCard(app, team, mons, v, { get code() { return codeState; }, foeId, fmt, cpu, setFoe: (x) => { foeId = x; draw(); }, setFmt: (x) => { fmt = x; draw(); }, setCpu: (x) => { cpu = x; draw(); }, ensureCode: ensureCode }));

    // other actions
    kids.push(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', dataset: { act: 'team-dup' }, disabled: P.teams.length >= EDITOR_LIMITS.teamsMax, onClick: () => { const r = app.dispatch({ type: 'teamDuplicate', teamId }); if (r.result && r.result.teamId) app.navigate({ name: 'team', teamId: r.result.teamId }); } }, 'Duplicate team'),
      h('button', { type: 'button', class: 'btn danger', dataset: { act: 'team-delete' }, onClick: async () => { if (await confirmDialog(app, { title: 'Delete this team?', message: `"${team.name}" and its ${mons.length} Pokemon will be deleted. You can undo this right after.`, confirmLabel: 'Delete team', danger: true })) { app.dispatch({ type: 'teamDelete', teamId }); app.navigate({ name: 'teams' }); } } }, 'Delete team')));
    ensureCode(team, mons);
    return kids;
  });
  // team codes are async: compute when the team's content changes, then redraw once
  async function ensureCode(team, mons) {
    const key = JSON.stringify([team.name, team.ruleset, mons.map((m) => [m.species, m.nickname, m.level, m.nature, m.abilitySlot, m.heldItem, m.moves, m.ev, m.iv, m.gender, m.shiny, m.friendship])]);
    if (codeState.key === key || codeState.busy === key) return;
    codeState = { ...codeState, busy: key };
    const r = mons.length ? await app.actions.encodeTeam(team.id) : { ok: false, message: 'Add a Pokemon first.' };
    if (app.route().teamId !== teamId) return;
    codeState = { key, code: r.ok ? r.code : null, error: r.ok ? null : r.message, busy: false };
    draw();
  }
  draw();
  return { el, update: draw };
}

function shareCard(app, team, mons, v, ctl) {
  const st = ctl.code;
  const P = app.state.profile;
  const others = P.teams.filter((t) => t.id !== team.id && teamMonsOf(P, t.id).length);
  const allowedFmts = formatsForTeamSize(mons.length);
  const fmt = ctl.fmt && allowedFmts.includes(ctl.fmt) ? ctl.fmt : formatForTeamSize(mons.length);
  const kids = [h('h3', null, 'Share and test')];
  const codeBox = h('textarea', { readOnly: true, rows: '3', 'aria-label': 'Team code', dataset: { teamCode: st.code ? '1' : '0', fk: 'team-code' }, value: st.code || '', placeholder: st.error || 'Working out the code...' });
  kids.push(codeBox);
  kids.push(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', dataset: { act: 'copy-code' }, disabled: !st.code, onClick: async () => { const ok = await app.actions.copyText(st.code, codeBox); app.toast(ok ? 'Team code copied.' : 'Could not copy automatically: the code is selected, copy it by hand.', ok ? '' : 'bad'); } }, 'Copy code'),
    st.error ? h('span', { class: 'dim', role: 'status' }, st.error) : h('span', { class: 'dim' }, st.code ? `${st.code.length} characters` : '')));
  const can = !!st.code && v.ok && mons.length > 0;
  const seed = ctl.seed = ctl.seed || seedFrom((n) => crypto.getRandomValues(new Uint8Array(n)));
  let href = null, err = null;
  if (can) { try { href = battleUrl({ team: st.code, foe: 'random', seed, format: fmt, cpu: ctl.cpu }); } catch (e) { err = e.message; } }
  kids.push(h('div', { class: 'row' },
    h('label', null, 'Battle format', h('select', { 'aria-label': 'Battle format', dataset: { fk: 'fmt' }, onChange: (e) => ctl.setFmt(e.target.value) }, FORMATS.filter((f) => allowedFmts.includes(f)).map((f) => h('option', { value: f, selected: f === fmt }, f)))),
    h('label', null, 'Computer opponent', h('select', { 'aria-label': 'Computer difficulty', dataset: { fk: 'cpu' }, onChange: (e) => ctl.setCpu(e.target.value) }, CPU_LEVELS.map((c) => h('option', { value: c, selected: c === ctl.cpu }, c))))));
  const link = (label, url, act, why) => h('a', { class: 'btn primary', href: url || null, 'aria-disabled': url ? null : 'true', dataset: { act }, role: url ? null : 'link', tabindex: url ? null : '0', title: url ? null : why, onClick: (e) => { if (!url) { e.preventDefault(); app.toast(why, 'bad'); } else { const fresh = seedFrom((n) => crypto.getRandomValues(new Uint8Array(n))); e.currentTarget.setAttribute('href', url.replace(/seed=\d+/, 'seed=' + fresh)); } } }, label);
  const why = !mons.length ? 'Add a Pokemon first.' : !st.code ? (st.error || 'Working out the team code...') : !v.ok ? `Fix the ${v.count} problem${v.count === 1 ? '' : 's'} above first.` : err || '';
  kids.push(h('div', { class: 'row' }, link('Test battle', href, 'test-battle', why)));
  if (others.length) {
    const sel = h('select', { 'aria-label': 'Opponent team', dataset: { fk: 'foe' }, onChange: (e) => ctl.setFoe(e.target.value) }, h('option', { value: '' }, 'Choose one of my other teams'), others.map((t) => h('option', { value: t.id, selected: ctl.foeId === t.id }, t.name)));
    kids.push(h('div', { class: 'stack' }, h('label', null, 'Test against another of my teams', sel)));
    let foeWhy = ctl.foeId ? 'Working out the other team\'s code...' : 'Pick an opponent team first.';
    const foeTeam = ctl.foeId ? findTeam(P, ctl.foeId) : null;
    if (foeTeam) { const fv = validationView(app.pack, teamMonsOf(P, foeTeam.id), foeTeam.ruleset); if (!fv.ok) foeWhy = `"${foeTeam.name}" has ${fv.count} problem${fv.count === 1 ? '' : 's'}; fix them first.`; }
    kids.push(h('div', { class: 'row' }, h('span', { dataset: { foePending: ctl.foeId || '' } }), (() => {
      const a = h('a', { class: 'btn', 'aria-disabled': 'true', dataset: { act: 'test-vs-other' }, title: foeWhy }, 'Test vs my other team');
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!ctl.foeId) { app.toast('Pick an opponent team first.', 'bad'); return; }
        const ft = findTeam(app.state.profile, ctl.foeId); const fvv = validationView(app.pack, teamMonsOf(app.state.profile, ctl.foeId), ft.ruleset);
        if (!can) { app.toast(why, 'bad'); return; }
        if (!fvv.ok) { app.toast(foeWhy, 'bad'); return; }
        const r = await app.actions.encodeTeam(ctl.foeId);
        if (!r.ok) { app.toast(r.message, 'bad'); return; }
        const url = battleUrl({ team: st.code, foe: r.code, seed: seedFrom((n) => crypto.getRandomValues(new Uint8Array(n))), format: fmt, cpu: ctl.cpu });
        a.setAttribute('href', url);
        app.actions.openUrl(url);
      });
      return a;
    })()));
  }
  kids.push(h('p', { class: 'dim' }, 'Test battle opens the battle page with this team against a random one. The code is the whole team: nothing is uploaded.'));
  return h('div', { class: 'card stack', dataset: { share: '1' } }, ...kids);
}

/* ================================================================================================ the mon editor */

export function monView(app, teamId, monId, tab) {
  const el = h('section', { class: 'screen', 'aria-labelledby': 'h-mon' });
  const head = h('div', { class: 'card' });
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections', 'data-tabs': true });          // data-tabs: the input layer's L / R shoulder buttons step through the links inside
  const pane = h('div', { class: 'stack', dataset: { tab } });
  const probs = h('div', { class: 'card', 'aria-live': 'polite', role: 'status', dataset: { monValidation: '1' } });
  el.append(head, tabs, pane, probs);
  const ctxOf = () => {
    const P = app.state.profile;
    const team = findTeam(P, teamId);
    const mon = team && team.monIds.includes(monId) ? findMon(P, monId) : null;
    return { P, team, mon, R: team ? resolveRuleset(team.ruleset) : null };
  };
  let statsPanel = null;
  let lastSpecies = null, lastShiny = null, lastGender = null;
  const upd = () => {
    const { team, mon, R } = ctxOf();
    if (!mon) { app.navigate(team ? { name: 'team', teamId } : { name: 'teams' }, { replace: true }); return; }
    const sp = app.pack.species[mon.species] || null;
    if (!sp) {
      // A record whose species this ROM has no entry for (a hand-edited file or a stale profile): nothing about it can be shown or edited, but the
      // player can swap the species or remove it, and the rules module's own reason is listed below. It never takes the screen down.
      lastSpecies = null; statsPanel = null;
      head.replaceChildren(h('div', { class: 'monhead', dataset: { unknownSpecies: String(mon.species) } }, h('div', { class: 'sprite' }, noPicEl(app, 2, 'no picture', 64)),
        h('div', { class: 'who' }, h('h2', { id: 'h-mon', tabindex: '-1', class: 'name', style: 'margin:0' }, 'Unknown Pokemon #' + mon.species),
          h('span', { class: 'dim' }, 'This ROM has no Pokemon with that number, so this record cannot be edited or used in a battle. Pick another species or remove it.'),
          h('div', { class: 'row tight' },
            h('button', { type: 'button', class: 'btn small', dataset: { act: 'change-species' }, onClick: () => openSpeciesPicker(app, { ruleset: team.ruleset, current: null, onPick: (id) => app.dispatch({ type: 'monSet', monId, field: 'species', value: id }) }) }, 'Change species'),
            h('button', { type: 'button', class: 'btn small danger', dataset: { act: 'mon-remove' }, onClick: () => { app.dispatch({ type: 'monRemove', teamId, monId }); app.navigate({ name: 'team', teamId }); } }, 'Remove from team')))));
      tabs.replaceChildren(); put(pane);
      const bad = monProblems(app.pack, mon, team.ruleset);
      put(probs, h('h3', null, 'Does this Pokemon pass the rules?'), bad.ok ? h('p', { class: 'ok-line' }, 'Yes.') : problemList(app, bad.problems));
      probs.dataset.monValidation = bad.ok ? 'ok' : 'bad';
      return;
    }
    // header
    if (lastSpecies !== mon.species || lastShiny !== mon.shiny || lastGender !== mon.gender || !head.firstChild) {
      lastSpecies = mon.species; lastShiny = mon.shiny; lastGender = mon.gender;
      head.replaceChildren(h('div', { class: 'monhead' }, h('div', { class: 'sprite' }, spriteEl(app, mon.species, { shiny: mon.shiny, female: mon.gender === 'F', scale: 2 })),
        h('div', { class: 'who' }, h('h2', { id: 'h-mon', tabindex: '-1', class: 'name', style: 'margin:0' }, mon.nickname || sp.name), h('span', { class: 'dim' }, `${mon.nickname ? sp.name + ' \u00b7 ' : ''}#${sp.natDex} \u00b7 Lv ${mon.level}`), typeBadges(app, sp, 1),
          h('div', { class: 'row tight' }, h('button', { type: 'button', class: 'btn small', dataset: { act: 'change-species' }, onClick: () => openSpeciesPicker(app, { ruleset: team.ruleset, current: mon.species, onPick: (id) => app.dispatch({ type: 'monSet', monId, field: 'species', value: id }) }) }, 'Change species')))));
    } else {
      const nm = head.querySelector('h2'); if (nm) nm.textContent = mon.nickname || sp.name;
      const sub = head.querySelector('.dim'); if (sub) sub.textContent = `${mon.nickname ? sp.name + ' \u00b7 ' : ''}#${sp.natDex} \u00b7 Lv ${mon.level}`;
    }
    // tabs
    tabs.replaceChildren(...TABS.map((t) => h('a', { href: routeHash({ name: 'mon', teamId, monId, tab: t }), 'aria-current': t === tab ? 'page' : null, 'data-nav-default': t === tab ? true : null, dataset: { tab: t } }, { build: 'Build', moves: 'Moves', stats: 'Stats' }[t])));
    // pane
    if (tab === 'stats') { if (!statsPanel) statsPanel = buildStats(app, monId, teamId, pane); statsPanel.update(); }
    else { statsPanel = null; rebuild(pane, () => (tab === 'moves' ? movesTab(app, team, mon, R) : buildTab(app, team, mon, R))); }
    // problems
    const mp = monProblems(app.pack, mon, team.ruleset);
    put(probs, h('h3', null, 'Does this Pokemon pass the rules?'), mp.ok ? h('p', { class: 'ok-line' }, `Yes (${rulesetLabel(team.ruleset)}).`) : problemList(app, mp.problems));
    probs.dataset.monValidation = mp.ok ? 'ok' : 'bad';
  };
  upd();
  return { el, update: upd, tab };
}

function sectionTitle(t, sub) { return h('div', null, h('h3', null, t), sub ? h('p', { class: 'dim', style: 'margin:-4px 0 6px' }, sub) : null); }

// W1 fix D9: a nickname used to be committed only on change / blur, so "type, wait, reload" lost it while the header said Saved. It is now committed (debounced) while
// typing and flushed when the page is hidden or closed.
const nickFlushers = new Set();
let nickHooked = false;
function hookNickFlush() {
  if (nickHooked || typeof window === 'undefined') return;
  nickHooked = true;
  const flush = () => { for (const fn of [...nickFlushers]) { if (fn.el && !fn.el.isConnected) { nickFlushers.delete(fn); continue; } try { fn(); } catch (_e) { /* a flush must never break unloading */ } } };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}
export const NICK_DEBOUNCE_MS = 400;

function buildTab(app, team, mon, R) {
  const monId = mon.id;
  const sp = app.pack.species[mon.species];
  const set = (field, value, coalesce) => app.dispatch({ type: 'monSet', monId, field, value, coalesce });
  const kids = [];
  // identity: nickname, level
  const nick = h('input', { type: 'text', value: mon.nickname, maxlength: String(PROFILE_LIMITS.nickname), placeholder: sp.name, 'aria-label': 'Nickname', dataset: { fk: 'nick' }, autocomplete: 'off' });
  { // commit while typing (debounced), on blur / Enter (change) and when the page goes away
    hookNickFlush();
    let timer = null, last = mon.nickname;
    const commit = (quiet) => { clearTimeout(timer); timer = null; if (nick.value === last) return null; const r = app.dispatch({ type: 'monSet', monId: mon.id, field: 'nickname', value: nick.value, coalesce: 'nick:' + mon.id }, { quiet }); if (!r || !r.error) last = nick.value; return r; };
    const flusher = () => { if (timer !== null) commit(true); };
    flusher.el = nick; nickFlushers.add(flusher);
    nick.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => commit(true), NICK_DEBOUNCE_MS); });
    nick.addEventListener('change', () => { const r = commit(false); if (r && r.error) { nick.value = mon.nickname; last = mon.nickname; } });
    nick.addEventListener('blur', () => { if (timer !== null) commit(true); });
  }
  const levelFixed = R.level.fixed !== null;
  kids.push(h('div', { class: 'card stack' }, h('div', { class: 'form-grid two' },
    h('label', null, 'Nickname (optional)', nick),
    h('div', { class: 'stack' }, h('span', { class: 'dim' }, 'Level'), stepper(app, { fk: 'level', label: 'Level', value: mon.level, min: R.level.min, max: R.level.max, disabled: levelFixed, onChange: (n, c) => set('level', n, c), coalesce: 'level:' + monId }),
      h('span', { class: 'dim', dataset: { levelNote: '1' } }, levelFixed ? `These rules fix the level at ${R.level.fixed}.` : R.level.battle !== null ? `Battles run at level ${R.level.battle}; the level here decides which level-up moves are allowed.` : 'Battles run at this level.')))));

  // gender + shiny + friendship
  const gopts = genderOptions(app.pack, mon.species);
  const gl = (g) => ({ M: { str: '{MALE}', aria: 'Male', kind: 'down' }, F: { str: '{FEMALE}', aria: 'Female', kind: 'up' }, '-': { str: '-', aria: 'Genderless', kind: 'plain' } }[g]);
  kids.push(h('div', { class: 'card stack' }, h('div', { class: 'row' },
    h('div', { class: 'stack' }, h('span', { class: 'dim' }, 'Gender'), segmented(gopts.map((g) => ({ value: g, aria: gl(g).aria, title: gl(g).aria, node: glyphEl(app, gl(g).str, gl(g).kind, 2, '') })), { label: 'Gender', current: mon.gender, onPick: (g) => set('gender', g) })),
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: mon.shiny, 'aria-label': 'Shiny', dataset: { fk: 'shiny' }, onChange: (e) => set('shiny', e.target.checked) }), 'Shiny (uses the ROM\'s shiny palette)'),
    h('div', { class: 'stack' }, h('span', { class: 'dim' }, 'Friendship'), stepper(app, { fk: 'friendship', label: 'Friendship', value: mon.friendship, min: 0, max: 255, step: 10, onChange: (n, c) => set('friendship', n, c), coalesce: 'friend:' + monId })))));

  // nature
  const nats = natureOptions(app.pack);
  const cur = nats[mon.nature];
  const sel = h('select', { 'aria-label': 'Nature', dataset: { fk: 'nature' }, onChange: (e) => set('nature', Number(e.target.value)) }, nats.map((n) => h('option', { value: n.id, selected: n.id === mon.nature }, n.label)));
  kids.push(h('div', { class: 'card stack' }, sectionTitle('Nature', 'It raises one stat by 10% and lowers another by 10%.'), sel,
    h('div', { class: 'natline', dataset: { natureSummary: cur.neutral ? 'neutral' : cur.up + '/' + cur.down } }, cur.neutral ? 'No stat is raised or lowered.' : [glyphEl(app, '{UP}', 'up', 1, 'raised'), h('strong', { style: 'color:var(--up)' }, STAT_LABELS[cur.up] + ' +10%'), h('span', { style: 'width:10px' }), glyphEl(app, '{DOWN}', 'down', 1, 'lowered'), h('strong', { style: 'color:var(--down)' }, STAT_LABELS[cur.down] + ' \u221210%')])));

  // ability
  const ab = abilityOptions(app.pack, mon.species, R);
  kids.push(h('div', { class: 'card stack' }, sectionTitle('Ability', 'The abilities this species really has in the ROM.'),
    h('div', { class: 'stack', role: 'radiogroup', 'aria-label': 'Ability' }, ab.slots.map((s) => {
      const id = uid('ab');
      return h('button', { type: 'button', class: 'pick', role: 'radio', 'aria-checked': String(s.slot === mon.abilitySlot), 'aria-disabled': s.allowed ? null : 'true', 'aria-describedby': id, dataset: { slot: s.slot, fk: 'ab' + s.slot }, onClick: () => { if (!s.allowed) { app.toast(s.text, 'bad'); return; } set('abilitySlot', s.slot); } },
        h('span', { class: 't' }, s.name, s.hidden ? ' (hidden)' : ''), h('span', { class: 'd', id }, s.allowed ? s.long.replace(/\n/g, ' ') : (s.code === 'ability.engine-unsupported' ? `${s.text}: ${abilityReason(app.pack, s.id).why}.` : s.text)));
    })),
    ab.innates.length ? h('div', { class: 'stack', dataset: { innates: '1' } }, h('span', { class: 'dim' }, `Innate abilities, from the ROM. In battle the first one works from level ${ENGINE_E.innateLevels[0]}, the second from level ${ENGINE_E.innateLevels[1]} and the third from level ${ENGINE_E.innateLevels[2]}, as in the game.`),
      ab.innates.map((i) => { const bad = unsupportedInnates(app.pack, mon.species).find((x) => x.id === i.id); return h('div', { class: 'dim' }, h('strong', { style: 'color:var(--fg)' }, i.name), ' \u2014 ', i.short, bad ? ` The arena cannot use it: ${bad.why}.` : ''); })) : null));

  // item
  const item = mon.heldItem ? app.pack.items[mon.heldItem] : null;
  kids.push(h('div', { class: 'card stack' }, sectionTitle('Held item'),
    h('button', { type: 'button', class: 'pick', dataset: { act: 'pick-item', fk: 'item' }, onClick: () => openItemPicker(app, { ruleset: team.ruleset, current: mon.heldItem, onPick: (id) => set('heldItem', id) }) }, h('span', { class: 't' }, item ? item.name : mon.heldItem ? 'Unknown item #' + mon.heldItem : 'No item'), h('span', { class: 'd', style: 'white-space:pre-line' }, item ? item.desc : mon.heldItem ? 'This ROM has no item with that number. Tap to choose another or remove it.' : 'Tap to choose an item.')),
    mon.heldItem ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onClick: () => set('heldItem', 0) }, 'Remove item')) : null));
  return kids;
}

function movesTab(app, team, mon, R) {
  const monId = mon.id;
  const kids = [sectionTitle('Moves', 'Up to four. Tap a slot to choose from the moves this Pokemon can learn.')];
  const slots = [];
  for (let i = 0; i < 4; i++) {
    const mv = mon.moves[i];
    if (!mv) {
      slots.push(h('button', { type: 'button', class: 'pick', dataset: { act: 'pick-move', slot: i, fk: 'mv' + i }, onClick: () => openMovePicker(app, { mon, ruleset: team.ruleset, slot: i, onPick: (id) => app.dispatch({ type: 'moveSet', monId, slot: i, moveId: id }) }) }, h('span', { class: 't' }, `Move ${i + 1}: add a move`), h('span', { class: 'd' }, 'Empty slot')));
      continue;
    }
    const m = app.pack.moves[mv.id];
    if (!m) {
      slots.push(h('div', { class: 'card stack', dataset: { moveSlot: i, move: mv.id, unknownMove: '1' } },
        h('button', { type: 'button', class: 'pick', dataset: { act: 'pick-move', slot: i, fk: 'mv' + i }, onClick: () => openMovePicker(app, { mon, ruleset: team.ruleset, slot: i, onPick: (id) => app.dispatch({ type: 'moveSet', monId, slot: i, moveId: id }) }) },
          h('span', { class: 't' }, 'Move ' + (i + 1) + ': unknown move #' + mv.id), h('span', { class: 'd' }, 'This ROM has no move with that number. Tap to replace it.')),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small danger', 'aria-label': 'Remove unknown move ' + mv.id, disabled: mon.moves.length <= 1, dataset: { act: 'move-clear' }, onClick: () => app.dispatch({ type: 'moveSet', monId, slot: i, moveId: null }) }, 'Remove'))));
      continue;
    }
    slots.push(h('div', { class: 'card stack', dataset: { moveSlot: i, move: mv.id } },
      h('button', { type: 'button', class: 'pick movebtn', dataset: { act: 'pick-move', slot: i, fk: 'mv' + i }, onClick: () => openMovePicker(app, { mon, ruleset: team.ruleset, slot: i, onPick: (id) => app.dispatch({ type: 'moveSet', monId, slot: i, moveId: id }) }) },
        h('span', { class: 'tb', style: 'grid-area:type' }, typeBadgeEl(app, m.type)),
        h('span', { class: 't', style: 'grid-area:name' }, m.name),
        h('span', { class: 'd', style: 'grid-area:sub;display:flex;gap:6px;align-items:center' }, categoryEl(app, m.category), `${m.category === 2 ? '\u2014' : m.power || '\u2014'} power \u00b7 ${m.accuracy ? m.accuracy + '%' : 'never misses'}`),
        h('span', { class: 'd', style: 'grid-area:pp;align-self:center' }, m.pp + ' PP')),
      h('p', { class: 'dim', style: 'white-space:pre-line;margin:0' }, m.desc),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', 'aria-label': `Move ${m.name} up`, disabled: i === 0, dataset: { act: 'move-up' }, onClick: () => app.dispatch({ type: 'moveReorder', monId, from: i, to: i - 1 }) }, 'Up'),
        h('button', { type: 'button', class: 'btn small', 'aria-label': `Move ${m.name} down`, disabled: i === mon.moves.length - 1, dataset: { act: 'move-down' }, onClick: () => app.dispatch({ type: 'moveReorder', monId, from: i, to: i + 1 }) }, 'Down'),
        h('button', { type: 'button', class: 'btn small danger', 'aria-label': `Remove ${m.name}`, disabled: mon.moves.length <= 1, dataset: { act: 'move-clear' }, onClick: () => app.dispatch({ type: 'moveSet', monId, slot: i, moveId: null }) }, 'Remove'))));
  }
  kids.push(h('div', { class: 'stack' }, slots));
  kids.push(h('p', { class: 'dim' }, 'Moves are checked by the rules module: level-up moves need the right level, and anything the arena engine cannot run yet is listed but disabled, with the reason.'));
  return kids;
}

/* ---- the stats panel: built once per mon, patched in place so a slider can be dragged while the numbers move ---- */

// Which order the Pokemon picker last used: the same kind of per-viewer convenience (localStorage if the browser lets us, never in the profile, never an undo step).
let sortPref = null;
function speciesSortPref(set) {
  if (set !== undefined) { sortPref = SPECIES_SORT_IDS.includes(set) ? set : 'dex'; try { localStorage.setItem('arena.editor.speciesSort', sortPref); } catch (_e) { /* storage may be blocked */ } return sortPref; }
  if (!sortPref) { try { const v = localStorage.getItem('arena.editor.speciesSort'); sortPref = SPECIES_SORT_IDS.includes(v) ? v : 'dex'; } catch (_e) { sortPref = 'dex'; } }
  return sortPref;
}

// Which EV view the player last chose (a per-viewer convenience: kept in localStorage if the browser lets us, never in the profile, and never an undo step).
let viewPref = null;
function statsViewPref(set) {
  if (set) { viewPref = set; try { localStorage.setItem('arena.editor.statsView', set); } catch (_e) { /* storage may be blocked */ } return set; }
  if (!viewPref) { try { viewPref = localStorage.getItem('arena.editor.statsView') === 'points' ? 'points' : 'ev'; } catch (_e) { viewPref = 'ev'; } }
  return viewPref;
}

function statScale(level) { return { hp: Math.floor(((2 * 150 + 31 + 63) * level) / 100) + level + 10, other: Math.floor(1.1 * (Math.floor(((2 * 150 + 31 + 63) * level) / 100) + 5)) }; }

function buildStats(app, monId, teamId, host) {
  const refs = {};
  let view = null;           // 'ev' | 'points'
  const getCtx = () => { const P = app.state.profile; const team = findTeam(P, teamId); const mon = findMon(P, monId); return { team, mon, R: resolveRuleset(team.ruleset) }; };
  const dispatchEv = (stat, value, mode, coalesce) => app.dispatch({ type: 'evSet', monId, stat, value, mode, coalesce });
  const build = () => {
    host.replaceChildren();
    const { R } = getCtx();
    view = R.points ? 'points' : statsViewPref();
    refs.top = h('div', { class: 'card stack' });
    refs.rows = h('div', { class: 'stats-grid stack' });
    refs.tools = h('div', { class: 'card stack' });
    host.append(refs.top, refs.rows, refs.tools);
    refs.stat = {};
    for (const k of STAT_ORDER) {
      const r = refs.stat[k] = {};
      r.lab = h('span', { class: 'lab' }, h('span', { class: 'nm' }, STAT_LABELS[k]), (r.arrow = h('span', { class: 'ar', 'aria-hidden': 'true' })));
      r.val = h('span', { class: 'val', dataset: { stat: k } }, '0');
      r.bar = h('span', { class: 'barwrap' }, (r.barCanvas = document.createElement('canvas')));
      r.barCanvas.className = 'rom'; r.barCanvas.setAttribute('aria-hidden', 'true');
      r.row = h('div', { class: 'statrow', dataset: { row: k } }, h('div', { class: 'line1' }, r.lab, r.val, r.bar), (r.line2 = h('div', { class: 'line2' })), (r.sliderWrap = h('div')));
      refs.rows.appendChild(r.row);
    }
  };
  const setNum = (input, v) => { if (document.activeElement !== input || input.value === '' || Number(input.value) !== v) input.value = String(v); };
  const update = () => {
    const { team, mon, R } = getCtx();
    if (!mon) return;
    if (!refs.top) build();
    const d = derived(app.pack, mon, team.ruleset);
    const b = budgets(mon, team.ruleset);
    const forced = !!R.points;
    if (forced) view = 'points';
    const nat = app.pack.natures[mon.nature];
    const up = nat && nat.up !== nat.down ? nat.up : null, down = nat && nat.up !== nat.down ? nat.down : null;
    const sc = d.ok ? statScale(d.level) : { hp: 300, other: 200 };
    // top: view toggle + counters
    const topKey = JSON.stringify([view, forced, b.ev && b.ev.used, b.points && b.points.used]);
    if (refs.topKey !== topKey) {
      refs.topKey = topKey;
      const ptsOver = b.points && b.points.over, evOver = b.ev && b.ev.over;
      put(refs.top,
        h('div', { class: 'spread' }, h('h3', { style: 'margin:0' }, 'Effort and stat points'),
          segmented([{ value: 'ev', label: 'EVs', disabled: forced, title: forced ? 'These rules store stat points; EVs follow' : '' }, { value: 'points', label: 'Stat points' }], { label: 'Effort view', current: view, onPick: (v) => { view = v; statsViewPref(v); refs.topKey = null; refs.stat && STAT_ORDER.forEach((k) => { refs.stat[k].ckey = null; }); update(); } })),
        view === 'ev'
          ? h('div', { class: 'counter' + (evOver ? ' over' : b.ev && b.ev.remaining === 0 ? ' full' : ''), role: 'status', 'aria-live': 'polite', dataset: { counter: 'ev' } }, h('span', { class: 'num' }, b.ev ? b.ev.remaining : '\u221e'), h('span', null, b.ev ? `EV left of ${b.ev.total} (each stat up to ${b.evPerStat})` : `EV (no total cap; each stat up to ${b.evPerStat})`))
          : h('div', { class: 'counter' + (ptsOver ? ' over' : b.points && b.points.remaining === 0 ? ' full' : ''), role: 'status', 'aria-live': 'polite', dataset: { counter: 'points' } }, h('span', { class: 'num' }, b.points.remaining), h('span', null, `points left of ${b.points.total} (each stat up to ${b.pointsPerStat})${forced ? '' : ' \u2014 Champions limit, advisory here; the EV cap decides'}`)),
        h('p', { class: 'stats-hint' }, view === 'ev'
          ? 'Every 4 EVs add 1 to a stat before level scaling; at level 50 two points of that make 1 stat point.'
          : 'One stat point adds 1 to a stat at level 50. The first point costs 4 EVs, each further point 8, so EVs and points always agree.'));
    }
    for (const k of STAT_ORDER) {
      const r = refs.stat[k];
      const isUp = k === up, isDown = k === down;
      r.row.className = 'statrow' + (isUp ? ' up' : isDown ? ' down' : '');
      const arrowKey = isUp ? 'u' : isDown ? 'd' : '-';
      if (r.arrowKey !== arrowKey) { r.arrowKey = arrowKey; r.arrow.replaceChildren(isUp ? glyphEl(app, '{UP}', 'up', 1, '') : isDown ? glyphEl(app, '{DOWN}', 'down', 1, '') : ''); r.lab.title = isUp ? 'Raised by the nature' : isDown ? 'Lowered by the nature' : ''; r.lab.dataset.nature = isUp ? 'up' : isDown ? 'down' : ''; }
      const v = d.ok ? d.stats[k] : 0;
      r.val.textContent = String(v);
      r.val.setAttribute('aria-label', `${STAT_LABELS[k]} ${v}${isUp ? ', raised by nature' : isDown ? ', lowered by nature' : ''}`);
      const bar = app.art.statBar(v, k === 'hp' ? sc.hp : sc.other, BAR_TILES);
      if (r.barKey !== v + ':' + (k === 'hp' ? sc.hp : sc.other)) { r.barKey = v + ':' + (k === 'hp' ? sc.hp : sc.other); paintCanvas(r.barCanvas, bar); r.barCanvas.style.width = bar.width * 2 + 'px'; r.barCanvas.style.height = bar.height * 2 + 'px'; r.barCanvas.dataset.fill = String(v); }
      // controls: build once per (view, forced), then patch values
      const ckey = view + ':' + forced + ':' + (R.iv.fixed !== null);
      if (r.ckey !== ckey) {
        r.ckey = ckey;
        r.line2.replaceChildren(); r.sliderWrap.replaceChildren();
        const evOrPts = (label, unit) => {
          const input = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': `${STAT_LABELS[k]} ${label}`, dataset: { fk: `${unit}-${k}`, ctl: unit, stat: k }, min: 0 });
          const dec = h('button', { type: 'button', class: 'btn', 'aria-label': `Decrease ${STAT_LABELS[k]} ${label}`, dataset: { fk: `${unit}-dec-${k}` } }, '\u2212');
          const inc = h('button', { type: 'button', class: 'btn', 'aria-label': `Increase ${STAT_LABELS[k]} ${label}`, dataset: { fk: `${unit}-inc-${k}` } }, '+');
          return { input, dec, inc, el: h('span', { class: 'grp' }, h('span', { class: 'gl' }, unit === 'ev' ? 'EV' : 'Pts'), dec, input, inc) };
        };
        const eg = evOrPts(view === 'ev' ? 'EVs' : 'stat points', view === 'ev' ? 'ev' : 'pts');
        r.eg = eg;
        const stepOf = () => (view === 'ev' ? 4 : 1);
        const cur = () => { const c = getCtx(); const dd = derived(app.pack, c.mon, c.team.ruleset); return view === 'ev' ? dd.evs[k] : dd.points[k]; };
        const send = (n, coalesce) => dispatchEv(k, n, view === 'ev' ? 'ev' : 'points', coalesce);
        eg.dec.addEventListener('click', () => send(cur() - stepOf()));
        eg.inc.addEventListener('click', () => send(cur() + stepOf()));
        eg.input.addEventListener('change', () => { const n = parseWhole(eg.input.value); if (n === null) { app.toast(`${STAT_LABELS[k]}: enter a whole number`, 'bad'); update(); return; } send(n); });
        eg.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); eg.input.dispatchEvent(new Event('change')); } });
        const slider = h('input', { type: 'range', min: '0', max: view === 'ev' ? String(R.ev.perStat) : String(b.pointsPerStat), step: view === 'ev' ? '4' : '1', 'aria-label': `${STAT_LABELS[k]} ${view === 'ev' ? 'EVs' : 'stat points'} slider`, dataset: { fk: `slider-${k}`, ctl: 'slider', stat: k } });
        slider.addEventListener('input', () => send(Number(slider.value), 'drag:' + monId + ':' + k));
        r.slider = slider;
        const ivInput = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': `${STAT_LABELS[k]} IV`, dataset: { fk: `iv-${k}`, ctl: 'iv', stat: k }, min: 0, max: R.iv.max, disabled: R.iv.fixed !== null });
        const ivDec = h('button', { type: 'button', class: 'btn', 'aria-label': `Decrease ${STAT_LABELS[k]} IV`, disabled: R.iv.fixed !== null, onClick: () => app.dispatch({ type: 'ivSet', monId, stat: k, value: getCtx().mon.iv[k] - 1 }) }, '\u2212');
        const ivInc = h('button', { type: 'button', class: 'btn', 'aria-label': `Increase ${STAT_LABELS[k]} IV`, disabled: R.iv.fixed !== null, onClick: () => app.dispatch({ type: 'ivSet', monId, stat: k, value: getCtx().mon.iv[k] + 1 }) }, '+');
        ivInput.addEventListener('change', () => { const n = parseWhole(ivInput.value); if (n === null) { app.toast(`${STAT_LABELS[k]} IV: enter a whole number`, 'bad'); update(); return; } app.dispatch({ type: 'ivSet', monId, stat: k, value: n }); });
        ivInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ivInput.dispatchEvent(new Event('change')); } });
        r.ivInput = ivInput;
        r.line2.append(eg.el, slider);
        r.sliderWrap.appendChild(h('span', { class: 'grp' }, h('span', { class: 'gl' }, 'IV'), ivDec, ivInput, ivInc));
      }
      const effV = view === 'ev' ? d.evs[k] : d.points[k];
      if (r.eg) { setNum(r.eg.input, effV); r.eg.input.max = view === 'ev' ? String(R.ev.perStat) : String(b.pointsPerStat); r.eg.dec.disabled = effV <= 0; r.eg.inc.disabled = effV >= (view === 'ev' ? R.ev.perStat : b.pointsPerStat); r.slider.value = String(effV); r.slider.setAttribute('aria-valuetext', `${effV} ${view === 'ev' ? 'EVs' : 'points'}`); }
      if (r.ivInput) setNum(r.ivInput, R.iv.fixed !== null ? R.iv.fixed : mon.iv[k]);
    }
    // tools
    const toolKey = JSON.stringify([forced, R.iv.fixed, view, mon.iv, d.ok && d.hiddenPower.type]);
    if (refs.toolKey !== toolKey) {
      refs.toolKey = toolKey;
      const snap = h('button', { type: 'button', class: 'btn', dataset: { act: 'snap' }, disabled: forced, onClick: () => app.dispatch({ type: 'evSnap', monId }) }, 'Snap EVs to the cheapest');
      const reset = h('button', { type: 'button', class: 'btn', dataset: { act: 'ev-reset' }, onClick: () => app.dispatch({ type: 'evReset', monId }) }, 'Reset ' + (view === 'ev' ? 'EVs' : 'points'));
      const fixed = R.iv.fixed !== null;
      const hpSel = h('select', { 'aria-label': 'Hidden Power type preset', disabled: fixed, dataset: { fk: 'hp-type' }, onChange: (e) => { if (e.target.value) app.dispatch({ type: 'ivPreset', monId, preset: 'hp:' + e.target.value }); } }, h('option', { value: '' }, 'Set IVs for Hidden Power...'), HIDDEN_POWER_TYPES.map((t) => h('option', { value: t.name }, t.name)));
      put(refs.tools, h('h3', { style: 'margin:0' }, 'Quick actions'),
        h('div', { class: 'row' }, reset, snap), fixed ? h('p', { class: 'dim', dataset: { ivNote: '1' } }, `These rules fix every IV at ${R.iv.fixed}.`) : null,
        h('div', { class: 'row' }, ['all31:All 31', 'zeroAtk:0 Attack', 'zeroSpe:0 Speed', 'zeroAtkSpe:0 Atk and Spe', 'all0:All 0'].map((s) => { const [id, label] = s.split(':'); return h('button', { type: 'button', class: 'btn small', disabled: fixed, dataset: { preset: id }, onClick: () => app.dispatch({ type: 'ivPreset', monId, preset: id }) }, label); })),
        h('div', { class: 'row' }, hpSel, d.ok ? h('span', { class: 'row tight', dataset: { hiddenPower: d.hiddenPower.type } }, typeBadgeEl(app, d.hiddenPower.typeId), h('span', { class: 'dim' }, `Hidden Power ${d.hiddenPower.type}, power ${d.hiddenPower.power}`)) : null),
        h('p', { class: 'dim' }, 'Hidden Power\'s type is worked out from the IVs; its power here is the ROM move table\'s fixed 60.'));
    }
  };
  build();
  return { update };
}
