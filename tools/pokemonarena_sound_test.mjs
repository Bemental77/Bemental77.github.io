#!/usr/bin/env node
// tools/pokemonarena_sound_test.mjs -- the Node half of the SOUND stage (MU3): the audio mixer, the music director and the panel's pure parts.
//
//   node tools/pokemonarena_sound_test.mjs            # battery + mutants + contract checks against music.js / music_map.js when they exist
//   node tools/pokemonarena_sound_test.mjs --no-mutants
//
// Never touches an audio device: every AudioContext is the recording double of tools/pokemonarena_sound_lib.mjs; the music engine and the song map are
// STAND-INS with the shared contract's exact signatures (the real modules, when present, get their own contract checks in section 4).
//
// 1. the battery (shared by the real modules and by every mutant): mixer (no context before an activation, graph, gain law, ramps, mute, hidden tab, persistence,
//    migration, hostile stored values, cross-tab), director (nothing before unlock, no restart, fallbacks, jingle then result music, pause / resume, soundtrack
//    switch, engine failure, effects), panel (pure step law)
// 2. the same battery on MUTANTS: each must fail its NAMED check while the unmutated twin stays quiet
// 3. static: only relative imports, no AudioContext constructed outside the mixer's factory, no top-level browser access
// 4. contract: the real music_map.js / music.js, SKIPPED LOUDLY (counted) when absent
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './pokemonarena_hub_lib.mjs';
import { installFakeAudio, makeStubMusic, makeStubMap, STUB_SONGS } from './pokemonarena_sound_lib.mjs';

const { root, J } = L;
const JS = path.join(root, 'pokemonarena', 'js');
const C = L.makeCounter('sound-node');
const ARGS = new Set(process.argv.slice(2));
const flush = () => new Promise((r) => setImmediate(r));
const head = (s) => console.log('\n== ' + s);

/* ------------------------------------------------------------------------------------------------ rig helpers */
const memStore = (init) => { const m = new Map(Object.entries(init || {})); return { _m: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
function makeScope() {
  const l = {};
  return { _l: l, addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, removeEventListener(t, f) { l[t] = (l[t] || []).filter((x) => x !== f); }, dispatch(t, ev) { for (const f of (l[t] || []).slice()) f(ev); }, count: (t) => (l[t] || []).length };
}
function fakeTimers() { let id = 0; const q = new Map(); return { set: (fn, ms) => { q.set(++id, { fn, ms }); return id; }, clear: (h) => { q.delete(h); }, run() { const all = Array.from(q.entries()); q.clear(); for (const [, t] of all) t.fn(); return all.length; }, pending: () => q.size }; }
function rig(M, { store = memStore(), hidden = false, win = undefined, mixerOptions = {}, strict = false, allowed = false } = {}) {
  // strict / allowed: the double emulates the browser's autoplay policy (pokemonarena_sound_lib.mjs): strict && !allowed = a context that stays suspended until the page is allowed to start audio
  const log = {}; const scope = makeScope(); scope.__autoplayStrict = strict; scope.__autoplayAllowed = allowed; installFakeAudio(scope, log);
  const doc = Object.assign(makeScope(), { hidden });
  const timers = fakeTimers();
  const mixer = M.mixer.createMixer({ window: win === undefined ? scope : win, document: doc, storage: store, setTimeout: timers.set, clearTimeout: timers.clear, ...mixerOptions });
  return { mixer, log, scope, doc, timers, store };
}
const lastRamp = (node) => { const c = node.gain.calls.filter((x) => x[0] === 'ramp'); return c.length ? c[c.length - 1] : null; };
const target = (node) => node.gain.target;
const approx = (a, b) => Math.abs(a - b) < 1e-9;

// a hand-written DOM, just big enough for sound_panel.js (elements, attributes, dataset, text, listeners, focus); the browser run proves the real thing
function fakeDom() {
  const camel = (s) => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  const doc = { activeElement: null };
  class TextNode { constructor(t) { this.nodeType = 3; this.textContent = String(t); } }
  class El {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parent = null; this.listeners = {}; this.dataset = {}; this._text = null; this.hidden = false; this.value = ''; this.disabled = false; this.className = ''; this.scrollTop = 0; this.id = ''; }
    setAttribute(k, v) { v = String(v); if (k === 'hidden') { this.hidden = true; return; } this.attrs[k] = v; if (k === 'id') this.id = v; else if (k === 'value') this.value = v; else if (k === 'class') this.className = v; else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = v; }
    getAttribute(k) { if (k === 'hidden') return this.hidden ? '' : null; if (k === 'value') return this.value; return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'hidden') this.hidden = false; }
    hasAttribute(k) { return k in this.attrs || (k === 'hidden' && this.hidden); }
    appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c); c.parent = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new TextNode(c) : c); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
    get textContent() { return this._text !== null ? this._text : this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get isConnected() { let p = this; while (p.parent) p = p.parent; return p === doc.root; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
    focus() { doc.activeElement = this; }
    dispatch(t, ev = {}) { ev.type = t; if (ev.target === undefined) ev.target = this; for (const f of (this.listeners[t] || []).slice()) f(ev); return ev; }
    matches(sel) {
      if (sel.startsWith('#')) return this.id === sel.slice(1);
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel); if (!m) return false;
      const k = m[1]; const v = k in this.attrs ? this.attrs[k] : (k.startsWith('data-') && camel(k.slice(5)) in this.dataset ? this.dataset[camel(k.slice(5))] : undefined);
      return m[2] === undefined ? v !== undefined : v === m[2];
    }
  }
  doc.root = new El('html'); doc.head = new El('head'); doc.body = new El('body'); doc.documentElement = doc.root;
  doc.root.appendChild(doc.head); doc.root.appendChild(doc.body);
  doc.createElement = (t) => new El(t); doc.createTextNode = (t) => new TextNode(t);
  const all = (n, out = []) => { for (const c of n.children) if (c.nodeType === 1) { out.push(c); all(c, out); } return out; };
  doc.getElementById = (id) => all(doc.root).find((e) => e.id === id) || null;
  return { doc, find: (sel) => all(doc.root).find((e) => e.matches(sel)) || null, findAll: (sel) => all(doc.root).filter((e) => e.matches(sel)) };
}
// virtual setTimeout / setInterval for the code under test (the panel's hold-to-repeat uses the globals)
function fakeTimersGlobal() {
  const real = { st: globalThis.setTimeout, ct: globalThis.clearTimeout, si: globalThis.setInterval, ci: globalThis.clearInterval };
  let now = 0, id = 0; const q = new Map();
  globalThis.setTimeout = (fn, ms) => { q.set(++id, { fn, at: now + (ms || 0), every: 0 }); return id; };
  globalThis.setInterval = (fn, ms) => { q.set(++id, { fn, at: now + ms, every: ms }); return id; };
  globalThis.clearTimeout = globalThis.clearInterval = (h) => { q.delete(h); };
  return {
    advance(ms) { const end = now + ms; for (;;) { let best = null, bid = 0; for (const [i, t] of q) if (t.at <= end && (!best || t.at < best.at)) { best = t; bid = i; } if (!best) break; now = best.at; if (best.every) best.at += best.every; else q.delete(bid); best.fn(); } now = end; },
    pending: () => q.size,
    restore() { globalThis.setTimeout = real.st; globalThis.clearTimeout = real.ct; globalThis.setInterval = real.si; globalThis.clearInterval = real.ci; },
  };
}

async function unlocked(M, o) { const r = rig(M, o); r.mixer.attach(); r.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); return r; }

/* ------------------------------------------------------------------------------------------------ 1. the battery */
async function battery(M) {
  const R = [];
  const add = (name, cond, detail) => R.push({ name, ok: !!cond, detail });
  const step = async (name, fn) => { try { const r = await fn(); if (r && typeof r === 'object' && 'ok' in r) add(name, r.ok, r.detail); else add(name, r); } catch (e) { add(name, false, 'threw ' + (e && e.message)); } };
  const AM = M.mixer;

  /* ---- mixer: before the first activation ---- */
  // THE STARTING VOLUME IS NOW HALF THE SLIDER (the user: "play music as soon as you join, but at half volume on the slider"): a visitor with NOTHING stored starts at master 0.5, sound on. It used to be 0.7.
  await step('mixer: defaults (nothing stored) are master 0.5, music 0.6, fx 0.8, not muted, soulgold', () => { const r = rig(M); const s = r.mixer.settings(); return J(s) === J({ v: 1, master: 0.5, music: 0.6, fx: 0.8, muted: false, soundtrack: 'soulgold' }); });
  await step('mixer: a STORED choice always wins and is never overwritten: master 0.7 / muted stay as stored, nothing is written at construction, only the absent fields take the new defaults', () => {
    const raw = '{"muted":false,"v":1,"master":0.7,"music":0.6,"fx":0.8,"soundtrack":"soulgold"}';        // (not the order the mixer writes: a rewrite at construction would change it)
    const a = rig(M, { store: memStore({ 'arena.audio': raw }) });
    const b = rig(M, { store: memStore({ 'arena.audio': JSON.stringify({ v: 1, muted: true }) }) });
    const c = rig(M, { store: memStore({ 'arena.sound': '1' }) }); const d = rig(M, { store: memStore({ 'arena.sound': '0' }) });
    return a.mixer.settings().master === 0.7 && a.store._m.get('arena.audio') === raw && b.mixer.settings().muted === true && b.mixer.settings().master === 0.5 && c.mixer.settings().master === 0.5 && c.mixer.settings().muted === false && d.mixer.settings().muted === true;
  });
  await step('mixer: NO AudioContext exists before the first activation (construct, attach, volume, mute, soundtrack, duck, hidden)', async () => {
    const r = rig(M); r.mixer.attach(); r.mixer.setVolume('music', 0.3); r.mixer.setMuted(true); r.mixer.setMuted(false); r.mixer.setSoundtrack('ultraviolet'); r.mixer.duck(true); r.mixer.setHidden(true); r.mixer.setHidden(false);
    await flush();
    return r.log.ctor === 0 && r.mixer.getAudioState().created === false && r.mixer.ctx() === null && r.mixer.destination('music') === null;
  });
  // (touchstart is armed too: a first touch anywhere is the visitor's first gesture; the browser only starts the context from the events that count, and the listeners stay until it runs)
  await step('mixer: attach() listens for exactly keydown, mousedown, pointerdown, pointerup, touchstart, touchend', () => { const r = rig(M); r.mixer.attach(); return ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].every((t) => r.scope.count(t) === 1) && r.doc.count('visibilitychange') === 1; });
  await step('mixer: a first touch (touchstart) is tried as the first gesture', async () => { const r = rig(M); r.mixer.attach(); r.scope.dispatch('touchstart', { type: 'touchstart' }); await flush(); return r.log.ctor === 1 && r.mixer.running(); });
  // THE EARLY START (a page's mixer; sound_system.js passes earlyStart): try at attach(), without waiting for a gesture. The browser decides (the double emulates its autoplay policy).
  await step('early start, browser BLOCKS autoplay: the context is created at attach() but stays suspended (nothing can play), a prompt is still wanted, the gesture listeners stay armed', async () => {
    const r = rig(M, { mixerOptions: { earlyStart: true }, strict: true }); r.mixer.attach(); await flush();
    const st = r.mixer.getAudioState();
    return r.log.ctor === 1 && r.log.ctxs[0].state === 'suspended' && st.created === true && st.ctx === 'suspended' && !r.mixer.canPlay() && r.mixer.needsActivation() === true && r.log.blocked >= 1 && ['keydown', 'pointerdown', 'touchend'].every((t) => r.scope.count(t) === 1);
  });
  await step('early start, browser blocks: the visitor\'s very FIRST gesture anywhere starts it (one context, listeners removed, no second context)', async () => {
    const r = rig(M, { mixerOptions: { earlyStart: true }, strict: true }); r.mixer.attach(); await flush();
    r.scope.__autoplayAllowed = true;                                       // the browser now counts the gesture (what a real click does)
    r.scope.dispatch('pointerdown', { type: 'pointerdown', pointerType: 'mouse' }); await flush();
    return r.log.ctor === 1 && r.log.ctxs[0].state === 'running' && r.mixer.canPlay() && r.mixer.needsActivation() === false && r.scope.count('pointerdown') === 0 && r.scope.count('keydown') === 0;
  });
  await step('early start, browser ALLOWS autoplay: it is running at load, nothing is asked of the visitor, the listeners are gone', async () => {
    const r = rig(M, { mixerOptions: { earlyStart: true }, strict: true, allowed: true }); r.mixer.attach(); await flush();
    return r.log.ctor === 1 && r.log.ctxs[0].state === 'running' && r.mixer.canPlay() && r.mixer.needsActivation() === false && r.scope.count('keydown') === 0 && !(r.log.blocked > 0);
  });
  await step('early start: a muted visitor and a hidden tab get nothing at attach() (their first gesture / being shown still starts it)', async () => {
    const muted = rig(M, { mixerOptions: { earlyStart: true }, store: memStore({ 'arena.audio': JSON.stringify({ v: 1, muted: true }) }) }); muted.mixer.attach(); await flush();
    const hid = rig(M, { mixerOptions: { earlyStart: true }, hidden: true }); hid.mixer.attach(); await flush();
    const before = muted.log.ctor;                                   // nothing yet: a muted visitor has nothing to start
    muted.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush();
    return before === 0 && muted.log.ctor === 1 && muted.mixer.getAudioState().created === true && hid.log.ctor === 0;
  });
  // A PAGE THAT LOADED HIDDEN (opened in a background tab) had no early try at attach(); the one-shot used to be lost for good, so the visitor saw the "start the sound" hint on a browser that would have allowed it.
  await step('early start: a tab that LOADED hidden gets its early try the moment it is shown (autoplay allowed: running at once; blocked: a suspended context, then the first gesture starts it); a muted one and a never-attached mixer still wait', async () => {
    const show = (r) => { r.doc.hidden = false; r.mixer._onVisibility(); };
    const a = rig(M, { mixerOptions: { earlyStart: true }, hidden: true, strict: true, allowed: true }); a.mixer.attach(); await flush();
    const aBefore = a.log.ctor; show(a); await flush(); await flush();
    const b = rig(M, { mixerOptions: { earlyStart: true }, hidden: true, strict: true }); b.mixer.attach(); await flush(); show(b); await flush();
    const bBlocked = b.log.ctor === 1 && b.log.ctxs[0].state === 'suspended' && b.mixer.needsActivation() === true;
    b.scope.__autoplayAllowed = true; b.scope.dispatch('pointerdown', { type: 'pointerdown', pointerType: 'mouse' }); await flush();
    const m = rig(M, { mixerOptions: { earlyStart: true }, hidden: true, store: memStore({ 'arena.audio': JSON.stringify({ v: 1, muted: true }) }) }); m.mixer.attach(); show(m); await flush();
    const n = rig(M, { mixerOptions: { earlyStart: true }, hidden: true, strict: true, allowed: true }); show(n); await flush();           // never attach()ed: not a page's mixer yet
    return aBefore === 0 && a.log.ctor === 1 && a.log.ctxs[0].state === 'running' && a.mixer.canPlay() && bBlocked && b.log.ctor === 1 && b.log.ctxs[0].state === 'running' && m.log.ctor === 0 && n.log.ctor === 0;
  });
  await step('early start: a browser with no Web Audio is not asked to click for nothing (no prompt wanted)', async () => {
    const r = rig(M, { mixerOptions: { earlyStart: true }, win: makeScope() }); r.mixer.attach(); await flush();
    return r.log.ctor === 0 && r.mixer.getAudioState().ctxError === 'unsupported' && r.mixer.needsActivation() === false;
  });
  await step('early start is OFF for a bare mixer: nothing is created before a gesture (the guarantee the tests above state)', async () => { const r = rig(M, { strict: true }); r.mixer.attach(); await flush(); return r.log.ctor === 0; });
  await step('mixer: Escape, a touch pointerdown and a mouse pointerup are NOT activations (no context)', async () => {
    const r = rig(M); r.mixer.attach();
    r.scope.dispatch('keydown', { type: 'keydown', key: 'Escape' }); r.scope.dispatch('pointerdown', { type: 'pointerdown', pointerType: 'touch' }); r.scope.dispatch('pointerup', { type: 'pointerup', pointerType: 'mouse' });
    await flush(); return r.log.ctor === 0;
  });
  await step('mixer: a key press creates exactly ONE context (latencyHint playback), resumes it, and a second activation creates no second one', async () => {
    const r = await unlocked(M); r.scope.dispatch('keydown', { type: 'keydown', key: 'b' }); r.scope.dispatch('mousedown', { type: 'mousedown' }); await flush();
    return r.log.ctor === 1 && J(r.log.ctorArgs[0]) === J({ latencyHint: 'playback' }) && r.log.ctxs[0].state === 'running' && r.mixer.running() && r.mixer.canPlay();
  });
  await step('mixer: a mouse pointerdown, a touch pointerup and a touchend are activations', async () => {
    for (const ev of [{ type: 'pointerdown', pointerType: 'mouse' }, { type: 'pointerup', pointerType: 'touch' }, { type: 'touchend' }, { type: 'mousedown' }]) {
      const r = rig(M); r.mixer.attach(); r.scope.dispatch(ev.type, ev); await flush();
      if (r.log.ctor !== 1) return { ok: false, detail: J(ev) };
    }
    return true;
  });
  await step('mixer: once the context is RUNNING the activation listeners are removed (no work per later click)', async () => { const r = await unlocked(M); return ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend'].every((t) => r.scope.count(t) === 0); });
  await step('mixer: if the browser refuses to start the context the listeners stay and the next activation retries', async () => {
    const log = {}; const scope = makeScope(); const Fake = installFakeAudio(scope, log);
    Fake.prototype.resume = function () { log.resume++; return Promise.reject(new Error('not allowed')); };
    const mixer = M.mixer.createMixer({ window: scope, document: Object.assign(makeScope(), { hidden: false }), storage: memStore() });
    mixer.attach(); scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush();
    return log.ctor === 1 && log.resume === 2 && scope.count('keydown') === 1 && !mixer.running() && mixer.needsActivation();
  });
  await step('mixer: the graph is music->master, fx->master, master->limiter, limiter->destination and nothing else', async () => {
    const r = await unlocked(M); const g = r.log.gains; const id = (n) => n.id; const ws = r.log.waveShapers[0];
    const edges = r.log.connects.map((e) => e.join('>')).sort();
    return g.length === 3 && r.log.waveShapers.length === 1 && J(edges) === J([id(g[1]) + '>' + id(g[0]), id(g[2]) + '>' + id(g[0]), id(g[0]) + '>' + id(ws), id(ws) + '>destination'].sort()) && r.mixer.destination('music') === g[1] && r.mixer.destination('fx') === g[2] && r.mixer.destination('master') === g[0];
  });
  await step('mixer: the soft limiter is a WaveShaper whose curve is limiterCurve() (4097 points, identity under the knee, never above the ceiling) with no oversampling', async () => {
    const r = await unlocked(M); const ws = r.log.waveShapers[0]; const c = ws && ws.curve; const want = AM.limiterCurve();
    return !!c && c.length === 4097 && c.every((v, i) => v === want[i]) && ws.oversample === 'none' && c.every((v) => Math.abs(v) <= AM.LIMIT_CEIL + 1e-6) && Math.abs(c[4096] - AM.limit(1)) < 1e-6;
  });
  await step('mixer: a context WITHOUT createWaveShaper still works: master goes straight to the destination (no limiter, no throw)', async () => {
    const log = {}; const scope = makeScope(); const Fake = installFakeAudio(scope, log); delete Fake.prototype.createWaveShaper;
    const mixer = M.mixer.createMixer({ window: scope, document: Object.assign(makeScope(), { hidden: false }), storage: memStore() }); mixer.attach(); scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush();
    const edges = log.connects.map((e) => e.join('>')); return log.gains.length === 3 && edges.includes(log.gains[0].id + '>destination') && log.waveShapers.length === 0 && mixer.canPlay();
  });
  // a first-time visitor starts with Master at 0.5 (gain 0.51, about 6 dB under the real game: a quiet start on purpose) and Music / Effects at unity
  await step('mixer: a first-time visitor starts at Master 0.5 (gain (0.5/0.7)^2) with music and effects at gain 1.0', async () => { const r = await unlocked(M); const [m, mu, fx] = r.log.gains; return approx(m.gain.value, (0.5 / 0.7) ** 2) && approx(mu.gain.value, 1) && approx(fx.gain.value, 1) && J(AM.DEFAULTS.master + ',' + AM.DEFAULTS.music + ',' + AM.DEFAULTS.fx) === J('0.5,0.6,0.8') && J(AM.UNITY.master + ',' + AM.UNITY.music + ',' + AM.UNITY.fx) === J('0.7,0.6,0.8'); });
  // (the law did not move when the starting volume did: UNITY is the anchor, so a visitor who stored 0.7 / 0.6 / 0.8 earlier still plays at the game's own level)
  await step('mixer: at the UNITY slider positions (0.7 / 0.6 / 0.8) every bus has gain exactly 1.0 (the real game\'s own level), and a stored 0.7 master is unity', async () => { const r = await unlocked(M, { store: memStore({ 'arena.audio': JSON.stringify({ v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: false, soundtrack: 'soulgold' }) }) }); const [m, mu, fx] = r.log.gains; return approx(m.gain.value, 1) && approx(mu.gain.value, 1) && approx(fx.gain.value, 1); });
  await step('mixer: stored levels from before the new law stay sane: the old defaults (0.7 / 0.6 / 0.8) are unity, a stored music 0.3 is 0.25 (quarter amplitude), 1.0 is +3 dB, nothing is louder than +6 dB overall', async () => {
    const r = await unlocked(M, { store: memStore({ 'arena.audio': JSON.stringify({ v: 1, master: 0.7, music: 0.3, fx: 1, muted: false, soundtrack: 'soulgold' }) }) }); const [m, mu, fx] = r.log.gains;
    const r2 = await unlocked(M, { store: memStore({ 'arena.audio': JSON.stringify({ v: 1, master: 1, music: 1, fx: 1, muted: false, soundtrack: 'soulgold' }) }) });
    const [m2, mu2] = r2.log.gains; return approx(m.gain.value, 1) && approx(mu.gain.value, 0.25) && approx(fx.gain.value, AM.GAIN_MAX) && approx(m2.gain.value * mu2.gain.value, AM.GAIN_MAX * AM.GAIN_MAX) && Math.abs(20 * Math.log10(m2.gain.value * mu2.gain.value) - 6) < 0.001;
  });
  await step('mixer: gain law: 0 -> 0, the default position -> 1.0, half the default -> 0.25 (square law below), 1.0 -> +3 dB, clamped (1.7 -> +3 dB, -3 -> 0, NaN -> 0), for each bus', () => ['master', 'music', 'fx'].every((b) => { const d = AM.UNITY[b]; return AM.gainFor(0, b) === 0 && approx(AM.gainFor(d, b), 1) && approx(AM.gainFor(d / 2, b), 0.25) && approx(AM.gainFor(1, b), AM.GAIN_MAX) && approx(AM.gainFor(1.7, b), AM.GAIN_MAX) && AM.gainFor(-3, b) === 0 && AM.gainFor(NaN, b) === 0; }) && approx(20 * Math.log10(AM.GAIN_MAX), 3.0103 - 0.0103));
  await step('mixer: gain law is strictly increasing over the 21 slider steps', () => { let p = -1; for (let i = 0; i <= 20; i++) { const g = AM.gainFor(i / 20, 'music') + AM.gainFor(i / 20, 'master') + AM.gainFor(i / 20, 'fx'); if (!(g > p)) return false; p = g; } return true; });

  /* ---- mixer: each slider moves its own bus, with a click-free ramp ---- */
  await step('mixer: each bus slider moves ONLY its own bus (music 0.5 -> music node (0.5/0.6)^2; master and fx untouched)', async () => {
    const r = await unlocked(M); const [m, mu, fx] = r.log.gains; const m0 = target(m), f0 = target(fx);
    r.mixer.setVolume('music', 0.5);
    return approx(target(mu), (0.5 / 0.6) ** 2) && target(m) === m0 && target(fx) === f0 && r.mixer.volume('music') === 0.5;
  });
  await step('mixer: master 0.9 -> master node above unity (1 + 0.4142 x 2/3); fx 0.1 -> fx node (0.1/0.8)^2', async () => { const r = await unlocked(M); const [m, , fx] = r.log.gains; r.mixer.setVolume('master', 0.9); r.mixer.setVolume('fx', 0.1); return approx(target(m), 1 + (AM.GAIN_MAX - 1) * (0.2 / 0.3)) && approx(target(fx), (0.1 / 0.8) ** 2); });
  await step('mixer: a volume change is a RAMP (cancelScheduledValues, setValueAtTime, linearRampToValueAtTime t+30ms), never a jump', async () => {
    const r = await unlocked(M); const mu = r.log.gains[1]; mu.gain.calls.length = 0; r.log.ctxs[0].currentTime = 2;
    r.mixer.setVolume('music', 0.2); const c = mu.gain.calls;
    return J(c.map((x) => x[0])) === J(['cancel', 'set', 'ramp']) && approx(c[2][1], (0.2 / 0.6) ** 2) && approx(c[2][2], 2.03);
  });
  await step('mixer: the same volume twice makes no second ramp and no second storage write', async () => { const r = await unlocked(M); r.mixer.setVolume('fx', 0.5); const w = r.mixer.getAudioState().storage.writes, n = r.log.gains[2].gain.calls.length; r.mixer.setVolume('fx', 0.5); return r.mixer.getAudioState().storage.writes === w && r.log.gains[2].gain.calls.length === n; });
  await step('mixer: a volume is stored with two decimals and clamped into 0..1 (1.7 -> 1, -1 -> 0, 0.123456 -> 0.12)', async () => { const r = rig(M); return r.mixer.setVolume('music', 1.7) === 1 && r.mixer.setVolume('music', -1) === 0 && r.mixer.setVolume('music', 0.123456) === 0.12; });
  await step('mixer: an unknown bus or a non-number volume throws a clear error', () => { const r = rig(M); let a = '', b = ''; try { r.mixer.setVolume('bass', 0.5); } catch (e) { a = e.message; } try { r.mixer.setVolume('music', 'loud'); } catch (e) { b = e.message; } return /unknown bus/.test(a) && /not a number/.test(b); });
  await step('mixer: a context double with only .value (no automation) still gets the value assigned', async () => {
    const gains = [];
    const ctx = { state: 'running', currentTime: 0, destination: {}, createGain() { const g = { gain: { value: 1 }, connect() {} }; gains.push(g); return g; }, resume() { return Promise.resolve(); }, suspend() { return Promise.resolve(); } };
    const mixer = M.mixer.createMixer({ window: makeScope(), document: Object.assign(makeScope(), { hidden: false }), storage: memStore(), createContext: () => ctx });
    mixer.unlock(); mixer.setVolume('music', 0.5); mixer.setMuted(true);
    return approx(gains[1].gain.value, (0.5 / 0.6) ** 2) && gains[0].gain.value === 0;
  });

  /* ---- mixer: mute ---- */
  await step('mixer: MUTE ramps the master to exactly 0 and leaves the music and fx buses where they were', async () => { const r = await unlocked(M); const [m, mu, fx] = r.log.gains; const a = target(mu), b = target(fx); r.mixer.setMuted(true); return target(m) === 0 && target(mu) === a && target(fx) === b && r.mixer.getAudioState().gains.master === 0; });
  await step('mixer: MUTE then suspends the context after the ramp (a silent page costs no CPU) and canPlay() is false', async () => {
    const r = await unlocked(M); r.mixer.setMuted(true);
    const before = r.log.suspend; r.timers.run(); await flush();
    return before === 0 && r.log.suspend === 1 && r.log.ctxs[0].state === 'suspended' && !r.mixer.canPlay();
  });
  await step('mixer: UNMUTE resumes the context and ramps the master back to its slider position (not 1)', async () => {
    const r = await unlocked(M); r.mixer.setVolume('master', 0.6); r.mixer.setMuted(true); r.timers.run(); await flush();
    const res = r.log.resume; r.mixer.setMuted(false); await flush();
    return r.log.resume === res + 1 && r.log.ctxs[0].state === 'running' && approx(target(r.log.gains[0]), (0.6 / 0.7) ** 2) && r.mixer.canPlay();
  });
  await step('mixer: an unmute that arrives before the suspend timer fires cancels the suspend', async () => { const r = await unlocked(M); r.mixer.setMuted(true); r.mixer.setMuted(false); r.timers.run(); await flush(); return r.log.suspend === 0 && r.log.ctxs[0].state === 'running'; });
  await step('mixer: muting before the first activation still creates the context at the first activation (a controller can unmute later) and then suspends it', async () => {
    const r = rig(M, { store: memStore({ 'arena.audio': JSON.stringify({ v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: true, soundtrack: 'soulgold' }) }) });
    r.mixer.attach(); r.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); r.timers.run(); await flush();
    const created = r.log.ctor === 1, silent = r.log.ctxs[0].state === 'suspended' && target(r.log.gains[0]) === 0 && !r.mixer.needsActivation();
    r.mixer.setMuted(false); await flush();
    return created && silent && r.log.ctxs[0].state === 'running' && r.mixer.canPlay();
  });
  await step('mixer: toggleMuted flips and reports; the sliders keep their positions through a mute', async () => { const r = await unlocked(M); r.mixer.setVolume('music', 0.35); const a = r.mixer.toggleMuted(), b = r.mixer.toggleMuted(); return a === true && b === false && r.mixer.volume('music') === 0.35; });
  await step('mixer: needsActivation is true before a context runs (and not muted), false when muted or running', async () => { const r = rig(M); const a = r.mixer.needsActivation(); r.mixer.setMuted(true); const b = r.mixer.needsActivation(); r.mixer.setMuted(false); r.mixer.attach(); r.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); return a === true && b === false && r.mixer.needsActivation() === false; });

  /* ---- mixer: hidden tab, duck ---- */
  await step('mixer: a hidden tab suspends the context at once; coming back resumes it', async () => {
    const r = await unlocked(M); r.doc.hidden = true; r.mixer._onVisibility(); await flush(); const a = r.log.ctxs[0].state === 'suspended' && !r.mixer.canPlay();
    r.doc.hidden = false; r.mixer._onVisibility(); await flush();
    return a && r.log.ctxs[0].state === 'running' && r.mixer.canPlay();
  });
  await step('mixer: coming back to a hidden tab while MUTED does not resume', async () => { const r = await unlocked(M); r.mixer.setMuted(true); r.timers.run(); await flush(); r.doc.hidden = true; r.mixer._onVisibility(); r.doc.hidden = false; r.mixer._onVisibility(); await flush(); return r.log.ctxs[0].state === 'suspended' && !r.mixer.canPlay(); });
  await step('mixer: a page that STARTS hidden does not run the context until it is visible', async () => { const r = rig(M, { hidden: true }); r.mixer.attach(); r.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); const a = r.log.ctxs[0].state; r.doc.hidden = false; r.mixer._onVisibility(); await flush(); return a === 'suspended' && r.log.ctxs[0].state === 'running'; });
  // (master starts at 0.5 now, so its gain is (0.5/0.7)^2 rather than 1.0; ducking must still leave it, and the effects, alone)
  await step('mixer: duck(true) halves ONLY the music bus (1.0 -> 0.5); duck(false) restores it', async () => { const r = await unlocked(M); const [m, mu, fx] = r.log.gains; const m0 = target(m); r.mixer.duck(true); const a = approx(target(mu), 0.5) && approx(target(m), m0) && approx(m0, (0.5 / 0.7) ** 2) && approx(target(fx), 1); r.mixer.duck(false); return a && approx(target(mu), 1); });

  /* ---- mixer: persistence, migration, hostile values ---- */
  await step('mixer: volumes, mute and soundtrack are stored in arena.audio and a NEW mixer reads them back', () => {
    const store = memStore(); const r = rig(M, { store }); r.mixer.setVolume('master', 0.45); r.mixer.setVolume('music', 0.3); r.mixer.setVolume('fx', 0.95); r.mixer.setMuted(true); r.mixer.setSoundtrack('ultraviolet');
    const back = rig(M, { store }).mixer.settings(); const raw = JSON.parse(store.getItem('arena.audio'));
    return J(back) === J({ v: 1, master: 0.45, music: 0.3, fx: 0.95, muted: true, soundtrack: 'ultraviolet' }) && J(raw) === J(back);
  });
  await step('mixer: the stored shape is exactly {v,master,music,fx,muted,soundtrack}', () => { const store = memStore(); const r = rig(M, { store }); r.mixer.setVolume('fx', 0.2); return J(Object.keys(JSON.parse(store.getItem('arena.audio')))) === J(['v', 'master', 'music', 'fx', 'muted', 'soundtrack']); });
  await step('mixer: nothing is written until something changes (a default page leaves storage empty)', () => { const store = memStore(); rig(M, { store }); return store._m.size === 0; });
  await step('mixer: MIGRATION: the old arena.sound "1" becomes sound on and arena.audio is written once; the old key is left alone', () => {
    const store = memStore({ 'arena.sound': '1' }); const r = rig(M, { store });
    const s = r.mixer.settings(), wrote = store.getItem('arena.audio') !== null, keep = store.getItem('arena.sound') === '1';
    store.setItem('arena.sound', '0'); const again = rig(M, { store }).mixer.settings();                              // a later change of the old key is ignored: it migrated ONCE
    return s.muted === false && wrote && keep && again.muted === false;
  });
  await step('mixer: MIGRATION: the old arena.sound "0" (the player had switched sound off) becomes muted', () => { const store = memStore({ 'arena.sound': '0' }); return rig(M, { store }).mixer.settings().muted === true && JSON.parse(store.getItem('arena.audio')).muted === true; });
  await step('mixer: MIGRATION: any other old value (or none) leaves the default (sound on) and writes nothing', () => { const a = memStore({ 'arena.sound': 'yes' }); const b = memStore(); return rig(M, { store: a }).mixer.settings().muted === false && a.getItem('arena.audio') === null && rig(M, { store: b }).mixer.settings().muted === false; });
  await step('mixer: arena.audio wins over arena.sound when both exist', () => { const store = memStore({ 'arena.sound': '0', 'arena.audio': JSON.stringify({ v: 1, master: 0.2, music: 0.2, fx: 0.2, muted: false, soundtrack: 'soulgold' }) }); const s = rig(M, { store }).mixer.settings(); return s.muted === false && s.master === 0.2; });
  const HOSTILE = [
    ['null', 'null'], ['an array', '[1,2]'], ['a string', '"loud"'], ['master a string', '{"master":"loud"}'], ['master 9', '{"master":9}'], ['master -1', '{"master":-1}'],
    ['muted "yes"', '{"muted":"yes"}'], ['soundtrack path', '{"soundtrack":"../../etc/passwd"}'], ['not json', '{master:'], ['empty string', ''], ['huge', '{"x":"' + 'a'.repeat(6000) + '"}'],
    ['proto', '{"__proto__":{"muted":true},"constructor":{"x":1}}'], ['nested', '{"master":{"a":1},"music":[0.5],"fx":null}'],
  ];
  await step('mixer: hostile stored values (' + HOSTILE.length + ' of them) never throw and always give valid settings', () => {
    for (const [name, text] of HOSTILE) {
      let s; try { s = rig(M, { store: memStore({ 'arena.audio': text }) }).mixer.settings(); } catch (e) { return { ok: false, detail: name + ' threw ' + e.message }; }
      const good = ['master', 'music', 'fx'].every((k) => typeof s[k] === 'number' && s[k] >= 0 && s[k] <= 1) && typeof s.muted === 'boolean' && ['soulgold', 'ultraviolet'].includes(s.soundtrack) && s.v === 1;
      if (!good) return { ok: false, detail: name + ' -> ' + J(s) };
    }
    return true;
  });
  await step('mixer: hostile values are REPAIRED field by field (master 9 -> 1, music kept, muted "yes" -> default) and the repair is written back', () => {
    const store = memStore({ 'arena.audio': '{"master":9,"music":0.25,"muted":"yes","soundtrack":"nope"}' }); const r = rig(M, { store }); const s = r.mixer.settings();
    return s.master === 1 && s.music === 0.25 && s.muted === false && s.soundtrack === 'soulgold' && r.mixer.getAudioState().storage.source === 'repaired' && JSON.parse(store.getItem('arena.audio')).master === 1;
  });
  await step('mixer: "__proto__" in the stored JSON does not mute the page or pollute Object', () => { const s = rig(M, { store: memStore({ 'arena.audio': '{"__proto__":{"muted":true}}' }) }).mixer.settings(); return s.muted === false && ({}).muted === undefined; });
  await step('mixer: a throwing getItem, a throwing setItem and no storage at all all keep working (in memory)', () => {
    const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
    const a = rig(M, { store: bad }), b = rig(M, { store: null });
    a.mixer.setVolume('music', 0.4); b.mixer.setVolume('music', 0.4);
    return a.mixer.volume('music') === 0.4 && b.mixer.volume('music') === 0.4 && a.mixer.getAudioState().storage.ok === false && b.mixer.getAudioState().storage.ok === false && a.mixer.settings().muted === false;
  });
  await step('mixer: another tab changing arena.audio (storage event) updates this page and tells the listeners', async () => {
    const store = memStore(); const r = await unlocked(M, { store }); const seen = []; r.mixer.on((e) => seen.push(e.type));
    store.setItem('arena.audio', JSON.stringify({ v: 1, master: 0.7, music: 0.1, fx: 0.8, muted: false, soundtrack: 'soulgold' })); r.scope.dispatch('storage', { key: 'arena.audio' });
    return r.mixer.volume('music') === 0.1 && approx(target(r.log.gains[1]), (0.1 / 0.6) ** 2) && seen.includes('volume');
  });
  await step('mixer: no AudioContext support at all: unlock() is false, a typed reason is recorded, nothing throws', () => { const r = rig(M, { win: makeScope() }); const ok = r.mixer.unlock(); return ok === false && r.mixer.getAudioState().ctxError === 'unsupported' && !r.mixer.canPlay(); });
  await step('mixer: a constructor that throws is survived (second try without options, then unsupported)', () => {
    const scope = makeScope(); let n = 0; scope.AudioContext = function () { n++; throw new Error('blocked'); };
    const mixer = M.mixer.createMixer({ window: scope, document: Object.assign(makeScope(), { hidden: false }), storage: memStore() });
    return mixer.unlock() === false && n === 2 && mixer.getAudioState().ctxError === 'unsupported';
  });
  await step('mixer: getAudioState() is a plain JSON object (no nodes, no functions) with the documented keys', async () => {
    const r = await unlocked(M); const s = r.mixer.getAudioState(); const t = JSON.parse(JSON.stringify(s));
    return J(t) === J(s) && ['v', 'settings', 'gains', 'duck', 'ctx', 'created', 'unlocks', 'resumes', 'suspends', 'hidden', 'canPlay', 'needsActivation', 'ctxError', 'storage'].every((k) => k in s) && s.ctx === 'running' && s.created && s.canPlay;
  });
  await step('mixer: destroy() closes the context and detaches every listener', async () => { const r = await unlocked(M); r.mixer.destroy(); return r.log.close === 1 && r.doc.count('visibilitychange') === 0 && r.scope.count('storage') === 0; });

  /* ---- director ---- */
  const dr = async (opts = {}) => {
    const r = await unlocked(M, opts.rigOpts); const mlog = {}; const music = makeStubMusic(mlog); const map = opts.map || makeStubMap();
    const roms = { soulgold: new Uint8Array(8), ultraviolet: new Uint8Array(4) };
    const d = M.director.createDirector({ mixer: r.mixer, songFor: map.songFor, loadMusic: opts.loadMusic || (async () => music), romFor: async (st) => roms[st] });
    return { r, d, mlog, map };
  };
  await step('director: set() returns at once (a plain value, not a promise) even when the engine never finishes loading', async () => {
    const r = await unlocked(M); const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: () => new Promise(() => {}), romFor: async () => new Uint8Array(1) });
    const t = Date.now(); const ret = d.set('hub'); await flush(); return ret === undefined && Date.now() - t < 100 && d.state().loading === true;
  });
  await step('director: NOTHING is loaded or played before the visitor has acted (no context): no engine, no play', async () => {
    const r = rig(M); const mlog = {}; const music = makeStubMusic(mlog); let loads = 0;
    const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: async () => { loads++; return music; }, romFor: async () => new Uint8Array(1) });
    d.set('hub'); await flush(); return loads === 0 && mlog.create.length === 0 && mlog.play.length === 0;
  });
  await step('director: after the first activation the wanted song starts: createMusic gets the music bus, the fx bus and the ROM; play gets the hub index and the fades', async () => {
    const r = rig(M); const mlog = {}; const music = makeStubMusic(mlog);
    const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: async () => music, romFor: async () => new Uint8Array(8) });
    r.mixer.attach(); d.set('hub'); await flush(); const before = mlog.play.length;
    r.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); await flush();
    const c = mlog.create[0], p = mlog.play[0];
    return before === 0 && mlog.create.length === 1 && c.soundtrack === 'soulgold' && c.romLen === 8 && c.dest === r.log.gains[1].id && c.fx === r.log.gains[2].id && mlog.play.length === 1 && p.index === 10 && p.fadeInMs === 400 && p.crossfadeMs === 600;
  });
  await step('director: asking again for the song that is already playing does NOT restart it', async () => { const { d, mlog } = await dr(); d.set('hub'); await flush(); d.set('hub'); d.set('hub'); await flush(); return mlog.play.length === 1; });
  await step('director: a screen change plays the new song (editor 11, preview 12, battle 20/21/22 by CPU level)', async () => {
    const { d, mlog } = await dr(); d.set('hub'); await flush(); d.set('editor'); await flush(); d.set('preview'); await flush(); d.battle('easy'); await flush(); d.battle('normal'); await flush(); d.battle('hard'); await flush();
    return J(mlog.play.map((p) => p.index)) === J([10, 11, 12, 20, 21, 22]);
  });
  await step('director: an unknown CPU level plays the normal battle song', async () => { const { d, mlog } = await dr(); d.battle('godlike'); await flush(); return mlog.play.length === 1 && mlog.play[0].index === 21; });
  await step('director: FALLBACKS on Ultra Violet (no battle_hard, no editor, no preview): hard -> normal, editor -> hub, preview -> hub', async () => {
    const r = await unlocked(M, { store: memStore({ 'arena.audio': JSON.stringify({ v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: false, soundtrack: 'ultraviolet' }) }) });
    const mlog = {}; const music = makeStubMusic(mlog); const map = makeStubMap();
    const d = M.director.createDirector({ mixer: r.mixer, songFor: map.songFor, loadMusic: async () => music, romFor: async () => new Uint8Array(4) });
    d.battle('hard'); await flush(); d.set('editor'); await flush(); d.set('preview'); await flush();
    return J(mlog.play.map((p) => p.index)) === J([121, 110]);       // preview falls back to the hub song that is ALREADY playing: no restart
  });
  await step('director: a key with no song anywhere in its chain is silence (the playing song stops) and nothing throws', async () => { const { d, mlog } = await dr({ map: { songFor: (st, k) => (k === 'hub' ? STUB_SONGS.soulgold.hub : null) } }); d.set('hub'); await flush(); d.set('battle_hard'); await flush(); d.battle('hard'); await flush(); return mlog.play.length === 1 && mlog.stop.length >= 1; });
  await step('director: result(win) plays the victory JINGLE first; when the jingle ENDS the result music starts; result(lose) the same with defeat', async () => {
    const { d, mlog } = await dr(); d.battle('normal'); await flush(); d.result('win'); await flush();
    const a = mlog.play.map((p) => p.index); mlog.instances[0]._end(30); await flush();
    const b = mlog.play.map((p) => p.index); d.result('lose'); await flush(); mlog.instances[0]._end(31); await flush();
    return J(a) === J([21, 30]) && J(b) === J([21, 30, 40]) && J(mlog.play.map((p) => p.index)) === J([21, 30, 40, 31, 41]);
  });
  await step('director: a victory THEME that loops (music_map.js: SoulGold\'s trainer-victory song loops) is itself the result music: no hand-over, nothing waits for an "ended" that never comes', async () => {
    const songs = { soulgold: { ...STUB_SONGS.soulgold, victory_sting: { index: 30, loops: true, jingle: false, label: 'looping victory theme' } } };
    const { d, mlog } = await dr({ map: makeStubMap(songs) }); d.battle('normal'); await flush(); d.result('win'); await flush();
    mlog.instances[0]._end(30); await flush();                                     // even if an engine did report an end, the wanted song has no follow-up
    return J(mlog.play.map((p) => p.index)) === J([21, 30]) && d.state().want.then === undefined;
  });
  await step('director: when the result music is the fanfare\'s own song there is nothing to hand over to (no replay)', async () => {
    const songs = { soulgold: { ...STUB_SONGS.soulgold, result_win: STUB_SONGS.soulgold.victory_sting } };
    const { d, mlog } = await dr({ map: makeStubMap(songs) }); d.battle('normal'); await flush(); d.result('win'); await flush(); mlog.instances[0]._end(30); await flush();
    return J(mlog.play.map((p) => p.index)) === J([21, 30]);
  });
  await step('director: a resolver from the page (music_map.resolveSong) replaces the built-in fallback chains for every wanted key', async () => {
    const seen = []; const { r, mlog } = await dr();
    const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, resolve: (st, key) => { seen.push(st + ':' + key); return key === 'hub' ? { key: 'custom', song: { index: 77, loops: true, jingle: false, label: 'x' } } : null; }, loadMusic: async () => makeStubMusic(mlog), romFor: async () => new Uint8Array(1) });
    d.set('hub'); await flush(); d.set('editor'); await flush();
    return J(mlog.play.map((p) => p.index)) === J([77]) && seen.includes('soulgold:hub') && seen.includes('soulgold:editor') && mlog.stop.length === 1;
  });
  await step('director: result(draw) has no jingle: straight to the lose-result music', async () => { const { d, mlog } = await dr(); d.battle('easy'); await flush(); d.result('draw'); await flush(); return J(mlog.play.map((p) => p.index)) === J([20, 41]); });
  await step('director: a soundtrack with no jingle goes straight to the result music (Ultra Violet has no victory)', async () => {
    const r = await unlocked(M, { store: memStore({ 'arena.audio': JSON.stringify({ v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: false, soundtrack: 'ultraviolet' }) }) });
    const mlog = {}; const music = makeStubMusic(mlog); const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: async () => music, romFor: async () => new Uint8Array(4) });
    d.battle('normal'); await flush(); d.result('win'); await flush(); return J(mlog.play.map((p) => p.index)) === J([121, 140]);
  });
  await step('director: MUTE pauses the song, UNMUTE resumes it (no new play)', async () => { const { r, d, mlog } = await dr(); d.set('hub'); await flush(); r.mixer.setMuted(true); await flush(); const a = mlog.pause; r.timers.run(); await flush(); r.mixer.setMuted(false); await flush(); await flush(); return a === 1 && mlog.resume === 1 && mlog.play.length === 1; });
  await step('director: a hidden tab pauses the song, coming back resumes it', async () => { const { r, d, mlog } = await dr(); d.set('hub'); await flush(); r.doc.hidden = true; r.mixer._onVisibility(); await flush(); const a = mlog.pause; r.doc.hidden = false; r.mixer._onVisibility(); await flush(); await flush(); return a === 1 && mlog.resume === 1; });
  await step('director: a song asked for WHILE muted starts when the sound is unmuted', async () => { const { r, d, mlog } = await dr(); r.mixer.setMuted(true); r.timers.run(); await flush(); d.set('editor'); await flush(); const a = mlog.play.length; r.mixer.setMuted(false); await flush(); await flush(); return a === 0 && mlog.play.length === 1 && mlog.play[0].index === 11; });
  await step('director: switching the soundtrack disposes the old engine, builds a new one on the new ROM and plays the same screen\'s song from the new map', async () => {
    const { r, d, mlog } = await dr(); d.battle('normal'); await flush(); r.mixer.setSoundtrack('ultraviolet'); await flush(); await flush();
    return mlog.dispose === 1 && mlog.create.length === 2 && mlog.create[1].soundtrack === 'ultraviolet' && mlog.create[1].romLen === 4 && J(mlog.play.map((p) => p.index)) === J([21, 121]);
  });
  await step('director: an engine that fails to load leaves the game silent with the reason in state().error (no throw, no unhandled rejection)', async () => {
    const r = await unlocked(M); const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: async () => { throw new Error('music.js 404'); }, romFor: async () => new Uint8Array(1) });
    d.set('hub'); await flush(); d.playSfx('se_select'); const e = d.state().error; return !!e && e.where === 'load' && /404/.test(e.message) && d.state().engine === false;
  });
  await step('director: an engine whose play() throws is survived', async () => { const { d, mlog } = await dr(); d.set('hub'); await flush(); mlog.instances[0].play = () => { throw new Error('bad song'); }; d.set('editor'); await flush(); const e = d.state().error; return !!e && e.where === 'play' && d.state().cur === null; });
  await step('director: effects: playSfx maps a key to the SE index and calls music.playEffect with pan and volume', async () => { const { d, mlog } = await dr(); d.set('hub'); await flush(); d.playSfx('se_hit_super', { pan: -0.5, volume: 0.8 }); d.playSfx('se_select'); return J(mlog.effect) === J([{ index: 204, pan: -0.5, volume: 0.8 }, { index: 201, pan: 0, volume: 1 }]); });
  await step('director: effects BY INDEX (the animator\'s playse) reach playEffect unchanged; a negative or fractional index is refused', async () => { const { d, mlog } = await dr(); d.set('hub'); await flush(); d.playEffectIndex(217, 0.25); const a = mlog.effect.length === 1 && mlog.effect[0].index === 217 && mlog.effect[0].pan === 0.25; d.playEffectIndex(-1); d.playEffectIndex(1.5); return a && mlog.effect.length === 1; });
  await step('director: an effect is a NO-OP before the first activation, while muted, in a hidden tab, and for a key the soundtrack lacks', async () => {
    const r = rig(M); const mlog = {}; const music = makeStubMusic(mlog); const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: async () => music, romFor: async () => new Uint8Array(1) });
    d.playSfx('se_select'); const pre = mlog.effect.length;
    r.mixer.attach(); r.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); d.set('hub'); await flush(); await flush();
    r.mixer.setMuted(true); d.playSfx('se_select'); const muted = mlog.effect.length; r.mixer.setMuted(false); await flush(); r.doc.hidden = true; r.mixer._onVisibility(); d.playSfx('se_select'); const hid = mlog.effect.length; r.doc.hidden = false; r.mixer._onVisibility(); await flush();
    d.playSfx('se_does_not_exist'); const missing = mlog.effect.length; d.playSfx('se_select');
    return pre === 0 && muted === 0 && hid === 0 && missing === 0 && mlog.effect.length === 1;
  });
  await step('director: effects work even if the engine has no playEffect (an older music.js): silent, no throw', async () => { const { d, mlog } = await dr(); d.set('hub'); await flush(); delete mlog.instances[0].playEffect; return d.playSfx('se_select') === null; });
  await step('director: duck(true) ducks the music bus through the mixer, duck(false) restores it', async () => { const { r, d } = await dr(); const mu = r.log.gains[1]; d.duck(true); const a = approx(target(mu), 0.5); d.duck(false); return a && approx(target(mu), 1); });
  await step('director: dispose() disposes the engine and later mixer events do nothing', async () => { const { r, d, mlog } = await dr(); d.set('hub'); await flush(); d.dispose(); r.mixer.setMuted(true); r.mixer.setMuted(false); await flush(); return mlog.dispose === 1 && mlog.pause === 0 && mlog.resume === 0; });
  await step('director: stop() fades out and forgets the wanted song', async () => { const { r, d, mlog } = await dr(); d.set('hub'); await flush(); d.stop(); r.mixer.setMuted(true); r.mixer.setMuted(false); await flush(); await flush(); return mlog.stop.length === 1 && mlog.stop[0].fadeOutMs === 600 && mlog.play.length === 1; });
  // EFFECTS NEED THE ENGINE, NOT A SONG. A menu whose music is Off wants no song; its cursor / select sounds still need the engine. effects:true (the sound system of a page that plays effects: the hub, the battle page) keeps it loading; the default (and the team editor, which plays none) does not.
  await step('director: with effects:true the engine loads once the sound can play although NO song is wanted (and an effect then plays); without it the engine stays unloaded; nothing loads before the visitor has acted', async () => {
    const mk = async (eff, act) => { const r = act ? await unlocked(M) : rig(M); r.mixer.attach(); const mlog = {}; const music = makeStubMusic(mlog); const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: async () => music, romFor: async () => new Uint8Array(8), ...(eff ? { effects: true } : {}) }); d.stop(); d.sync(); for (let i = 0; i < 5; i++) await flush(); return { d, mlog, r }; };
    const on = await mk(true, true), off = await mk(false, true), idle = await mk(true, false);
    const h = on.d.playSfx('se_cursor');
    return on.mlog.create.length === 1 && on.mlog.play.length === 0 && on.d.state().engine === true && !!h && on.mlog.effect.length === 1 && on.mlog.effect[0].index === 200
      && off.mlog.create.length === 0 && off.d.state().engine === false && off.d.playSfx('se_cursor') === null && idle.mlog.create.length === 0 && idle.d.state().engine === false;
  });
  await step('director: effects:true -- the visitor\'s first activation (the context starts) loads the engine for a page that wants no song, and a soundtrack change rebuilds it on the new ROM', async () => {
    const r = rig(M); r.mixer.attach(); const mlog = {}; const music = makeStubMusic(mlog);
    const d = M.director.createDirector({ mixer: r.mixer, songFor: makeStubMap().songFor, loadMusic: async () => music, romFor: async (st) => new Uint8Array(st === 'ultraviolet' ? 4 : 8), effects: true });
    d.stop(); await flush(); const before = mlog.create.length;
    r.scope.dispatch('keydown', { type: 'keydown', key: 'a' }); for (let i = 0; i < 5; i++) await flush();
    const first = mlog.create.length === 1 && mlog.create[0].soundtrack === 'soulgold';
    r.mixer.setSoundtrack('ultraviolet'); for (let i = 0; i < 6; i++) await flush();
    return before === 0 && first && mlog.create.length === 2 && mlog.create[1].soundtrack === 'ultraviolet' && mlog.play.length === 0 && mlog.dispose === 1;
  });
  await step('director: the log records every play with its key, the key actually used and the index', async () => { const { d } = await dr(); d.battle('hard'); await flush(); const l = d.state().log.filter((x) => x.op === 'play'); return l.length === 1 && l[0].key === 'battle_hard' && l[0].usedKey === 'battle_hard' && l[0].index === 22; });

  /* ---- panel on a hand-written fake DOM (the browser run is tools/pokemonarena_sound_page_test.mjs) ---- */
  const pd = async (opts = {}) => {
    const FD = fakeDom(); const r = await unlocked(M, opts.rigOpts); const calls = { test: [], choose: [], open: 0, close: 0, done: 0, subs: 0 };
    const mixer = r.mixer; const origOn = mixer.on; mixer.on = (fn) => { calls.subs++; const off = origOn(fn); return () => { calls.subs--; off(); }; };
    const soundtracks = { labels: { soulgold: 'SoulGold', ultraviolet: 'Ultra Violet' }, status: () => ({ state: 'ready' }), choose: async (n) => { calls.choose.push(n); mixer.setSoundtrack(n); return { ok: true }; } };
    const panel = M.panel.createSoundPanel({ mixer, document: FD.doc, soundtracks, ownNav: false, onTest: (k) => calls.test.push(k), onOpen: () => calls.open++, onClose: () => calls.close++ });
    return { FD, r, mixer, panel, calls, q: (s) => FD.find(s) };
  };
  await step('panel DOM: open() builds ONE modal dialog "Sound" with three range sliders (0..100 step 5) at the stored levels, Mute, Test, two soundtrack radios, two Close buttons', async () => {
    const { FD, panel, mixer, calls } = await pd(); await panel.open();
    const d = FD.doc.getElementById('soundDialog'); const sl = ['master', 'music', 'fx'].map((b) => FD.find('[data-snd="slider-' + b + '"]'));
    return !!d && d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true' && !d.hidden && FD.doc.body.dataset.dialog === 'open' && calls.open === 1
      && sl.every((s) => s && s.getAttribute('type') === 'range' && s.getAttribute('min') === '0' && s.getAttribute('max') === '100' && s.getAttribute('step') === '5') && J(sl.map((s) => s.value)) === J(['50', '60', '80'])
      && !!FD.find('[data-snd="mute"]') && !!FD.find('[data-snd="test"]') && FD.findAll('[role="radio"]').length === 2 && FD.findAll('[data-nav-close]').length === 2 && FD.findAll('#soundDialog').length === 1 && mixer.volume('music') === 0.6;
  });
  await step('panel DOM: a slider input event sets ITS bus (music 35 -> 0.35, the fx and master untouched) and the readout', async () => {
    const { FD, panel, mixer, r } = await pd(); await panel.open();
    const s = FD.find('[data-snd="slider-music"]'); s.value = '35'; s.dispatch('input', { target: s });
    return mixer.volume('music') === 0.35 && mixer.volume('master') === 0.5 && mixer.volume('fx') === 0.8 && FD.find('[data-snd="value-music"]').textContent === '35%' && approx(target(r.log.gains[1]), (0.35 / 0.6) ** 2) && s.getAttribute('aria-valuetext') === '35 percent';
  });
  await step('panel DOM: a TOUCH is applied only as a tap (pointerup) or after it moved sideways; a vertical scroll that starts on a slider (pointercancel) puts the thumb back and changes nothing; a mouse is applied at once', async () => {
    const { FD, panel, mixer } = await pd(); await panel.open();
    const s = FD.find('[data-snd="slider-music"]');
    // a tap: the browser jumps the thumb at touchstart; nothing is applied until the finger lifts
    s.dispatch('pointerdown', { pointerType: 'touch', clientX: 100 }); s.value = '90'; s.dispatch('input', { target: s });
    const held = mixer.volume('music') === 0.6; s.dispatch('pointerup', { pointerType: 'touch' });
    const tapped = mixer.volume('music') === 0.9 && FD.find('[data-snd="value-music"]').textContent === '90%';
    // a vertical scroll over the slider: the browser cancels the pointer
    s.dispatch('pointerdown', { pointerType: 'touch', clientX: 100 }); s.value = '30'; s.dispatch('input', { target: s }); s.dispatch('pointermove', { pointerType: 'touch', clientX: 102 }); s.dispatch('pointercancel', {});
    const scrolled = mixer.volume('music') === 0.9 && s.value === '90';
    // a sideways drag: applied live once it has moved more than 8 px
    s.dispatch('pointerdown', { pointerType: 'touch', clientX: 100 }); s.value = '55'; s.dispatch('input', { target: s }); const wait2 = mixer.volume('music') === 0.9;
    s.dispatch('pointermove', { pointerType: 'touch', clientX: 130 }); const live1 = mixer.volume('music') === 0.55; s.value = '40'; s.dispatch('input', { target: s }); const live2 = mixer.volume('music') === 0.4; s.dispatch('pointerup', { pointerType: 'touch' });
    // a mouse
    s.dispatch('pointerdown', { pointerType: 'mouse', clientX: 100 }); s.value = '25'; s.dispatch('input', { target: s }); const mouse = mixer.volume('music') === 0.25; s.dispatch('pointerup', { pointerType: 'mouse' });
    return held && tapped && scrolled && wait2 && live1 && live2 && mouse;
  });
  await step('panel DOM: releasing the Effects slider plays the test cry; releasing Master or Music does not', async () => {
    const { FD, panel, calls } = await pd(); await panel.open();
    FD.find('[data-snd="slider-master"]').dispatch('change', {}); FD.find('[data-snd="slider-music"]').dispatch('change', {}); const none = calls.test.length === 0;
    FD.find('[data-snd="slider-fx"]').dispatch('change', {}); return none && J(calls.test) === J(['fx']);
  });
  await step('panel DOM: the Test button asks for a test cry', async () => { const { FD, panel, calls } = await pd(); await panel.open(); FD.find('[data-snd="test"]').dispatch('click', {}); return J(calls.test) === J(['button']); });
  await step('panel DOM: Mute toggles the mixer, the button says "Muted (click to unmute)" and aria-pressed; Mute again restores', async () => {
    const { FD, panel, mixer } = await pd(); await panel.open(); const m = FD.find('[data-snd="mute"]');
    m.dispatch('click', {}); const a = mixer.muted() === true && m.getAttribute('aria-pressed') === 'true' && /Muted/.test(m.textContent) && /muted/i.test(FD.find('[data-snd="note"]').textContent);
    m.dispatch('click', {}); return a && mixer.muted() === false && m.getAttribute('aria-pressed') === 'false' && m.textContent === 'Mute';
  });
  await step('panel DOM: a change made elsewhere (the M key, another tab) repaints the open panel', async () => {
    const { FD, panel, mixer } = await pd(); await panel.open(); mixer.setVolume('fx', 0.25); mixer.setMuted(true);
    return FD.find('[data-snd="slider-fx"]').value === '25' && FD.find('[data-snd="value-fx"]').textContent === '25%' && FD.find('[data-snd="mute"]').getAttribute('aria-pressed') === 'true';
  });
  await step('panel DOM: the - and + buttons move one 5% step per press (pointer down), clamp at 0 and 100, and the keyboard / controller click path steps once', async () => {
    const { FD, panel, mixer } = await pd(); await panel.open();
    const up = FD.find('[data-snd="up-music"]'), dn = FD.find('[data-snd="down-music"]');
    up.dispatch('pointerdown', { button: 0 }); up.dispatch('pointerup', {}); up.dispatch('click', {});          // the click that follows a pointer press must not step twice
    const a = mixer.volume('music') === 0.65;
    dn.dispatch('click', {});                                                                                 // keyboard Enter / controller A: a click with no pointerdown before it
    const b = mixer.volume('music') === 0.6;
    for (let i = 0; i < 30; i++) { up.dispatch('pointerdown', { button: 0 }); up.dispatch('pointerup', {}); up.dispatch('click', {}); }
    const c = mixer.volume('music') === 1;
    for (let i = 0; i < 30; i++) { dn.dispatch('pointerdown', { button: 0 }); dn.dispatch('pointerup', {}); dn.dispatch('click', {}); }
    return a && b && c && mixer.volume('music') === 0;
  });
  await step('panel DOM: HOLDING + repeats after 400 ms every 90 ms and stops on pointerup / leave (fake timers)', async () => {
    const T = fakeTimersGlobal(); try {
      const { FD, panel, mixer } = await pd(); await panel.open(); const up = FD.find('[data-snd="up-fx"]');
      up.dispatch('pointerdown', { button: 0 }); const first = mixer.volume('fx');
      T.advance(399); const before = mixer.volume('fx'); T.advance(1); T.advance(90 * 3); const after = mixer.volume('fx');
      up.dispatch('pointerup', {}); T.advance(2000); const stopped = mixer.volume('fx');
      return first === 0.85 && before === 0.85 && after === 1 && stopped === after && T.pending() === 0;
    } finally { T.restore(); }
  });
  await step('panel DOM: the wheel over a slider row steps 5% per notch (a small trackpad delta accumulates) and prevents the page scroll', async () => {
    const { FD, panel, mixer } = await pd(); await panel.open(); const row = FD.find('[data-bus="fx"]'); let prevented = 0;
    row.dispatch('wheel', { deltaY: -100, preventDefault() { prevented++; } }); const a = mixer.volume('fx') === 0.85;
    for (let i = 0; i < 4; i++) row.dispatch('wheel', { deltaY: 30, preventDefault() { prevented++; } });      // 120 -> one notch down
    return a && mixer.volume('fx') === 0.8 && prevented === 5;
  });
  await step('panel DOM: the soundtrack radios show the stored choice, a click asks for the other one', async () => {
    const { FD, panel, mixer, calls } = await pd(); await panel.open(); const sg = FD.find('[data-snd="soundtrack-soulgold"]'), uv = FD.find('[data-snd="soundtrack-ultraviolet"]');
    const a = sg.getAttribute('aria-checked') === 'true' && uv.getAttribute('aria-checked') === 'false';
    uv.dispatch('click', {}); await flush();
    return a && J(calls.choose) === J(['ultraviolet']) && mixer.soundtrack() === 'ultraviolet' && uv.getAttribute('aria-checked') === 'true' && sg.getAttribute('aria-checked') === 'false';
  });
  await step('panel DOM: Esc inside closes in ONE press and is consumed (preventDefault + stopPropagation); Close, the second Close and a backdrop click close too; onClose runs each time', async () => {
    let ok = true;
    for (const how of ['esc', 'close', 'close2', 'backdrop']) {
      const { FD, panel, calls } = await pd(); await panel.open(); const d = FD.doc.getElementById('soundDialog'); let pd1 = 0, sp = 0;
      if (how === 'esc') d.dispatch('keydown', { key: 'Escape', preventDefault() { pd1++; }, stopPropagation() { sp++; } });
      else if (how === 'close') FD.find('[data-snd="close"]').dispatch('click', {});
      else if (how === 'close2') FD.find('[data-snd="close2"]').dispatch('click', {});
      else d.dispatch('mousedown', { target: d });
      ok = ok && !panel.isOpen() && d.hidden === true && FD.doc.body.dataset.dialog === undefined && calls.close === 1 && (how !== 'esc' || (pd1 === 1 && sp === 1));
    }
    return ok;
  });
  await step('panel DOM: Esc with a modifier held, and any other key, do not close it', async () => { const { FD, panel } = await pd(); await panel.open(); const d = FD.doc.getElementById('soundDialog'); d.dispatch('keydown', { key: 'Escape', ctrlKey: true, preventDefault() {}, stopPropagation() {} }); d.dispatch('keydown', { key: 'a', preventDefault() {}, stopPropagation() {} }); return panel.isOpen(); });
  await step('panel DOM: open / close / open leaves no mixer subscription behind and builds the dialog once', async () => {
    const { FD, panel, calls } = await pd(); await panel.open(); const during = calls.subs; panel.close(); const after = calls.subs; await panel.open(); panel.close(); await panel.open();
    return during === 1 && after === 0 && calls.subs === 1 && FD.findAll('#soundDialog').length === 1 && calls.open === 3;
  });
  await step('panel DOM: open() gives the focus to the Master slider when the page has no navigation layer of its own; the focus goes back to the opener on close', async () => {
    const { FD, panel } = await pd(); const opener = FD.doc.createElement('button'); FD.doc.body.appendChild(opener); opener.focus();
    await panel.open(); const a = FD.doc.activeElement === FD.find('[data-snd="slider-master"]'); panel.close();
    return a && FD.doc.activeElement === opener;
  });
  await step('panel DOM: the note explains the browser rule while the sound has not been started, and says "muted" when muted', async () => {
    const { FD, panel, mixer } = await pd({ rigOpts: undefined }); const r2 = rig(M); const FD2 = fakeDom();
    const p2 = M.panel.createSoundPanel({ mixer: r2.mixer, document: FD2.doc, ownNav: false }); await p2.open();
    const locked = FD2.find('[data-snd="note"]').textContent; p2.close();
    await panel.open(); mixer.setMuted(true); const muted = FD.find('[data-snd="note"]').textContent;
    return /first click, tap or key press/.test(locked) && /controller button alone cannot start it/.test(locked) && /muted/i.test(muted);
  });

  /* ---- panel (pure parts) ---- */
  await step('panel: stepPercent moves by 5 (10 for a "big" press), stays a multiple of 5 and clamps at 0 and 100', () => {
    const P = M.panel.stepPercent;
    return P(70, 1) === 75 && P(70, -1) === 65 && P(70, 1, true) === 80 && P(70, -1, true) === 60 && P(100, 1) === 100 && P(0, -1) === 0 && P(98, 1) === 100 && P(3, 1) === 5 && P(3, -1) === 0 && P(NaN, 1) === 5;
  });
  await step('panel: toPercent / fromPercent round-trip every multiple of 5 and clamp', () => { for (let p = 0; p <= 100; p += 5) if (AM.toPercent(AM.fromPercent(p)) !== p) return false; return AM.fromPercent(150) === 1 && AM.fromPercent(-4) === 0 && AM.toPercent(0.123) === 12; });
  await step('panel: createSoundPanel without a mixer or without a document throws a clear error', () => { let a = '', b = ''; try { M.panel.createSoundPanel({}); } catch (e) { a = e.message; } try { M.panel.createSoundPanel({ mixer: { setVolume() {} }, document: null }); } catch (e) { b = e.message; } return /needs the audio mixer/.test(a) && /needs a document/.test(b); });
  return R;
}

/* ------------------------------------------------------------------------------------------------ module loading (real + mutants) */
async function importFrom(dir, name) { return import(pathToFileURL(path.join(dir, name)).href + '?v=' + Math.random().toString(36).slice(2)); }
async function loadSet(dir) { return { mixer: await importFrom(dir, 'audio_mixer.js'), director: await importFrom(dir, 'music_director.js'), panel: await importFrom(dir, 'sound_panel.js') }; }
function copySet(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['audio_mixer.js', 'music_director.js', 'sound_panel.js']) fs.copyFileSync(path.join(JS, f), path.join(dest, f));
  return dest;
}
function mutate(dir, file, from, to) {
  const p = path.join(dir, file), s = fs.readFileSync(p, 'utf8'); const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`mutation target found ${n}x in ${file} (want 1): ${from.slice(0, 80)}`);
  fs.writeFileSync(p, s.replace(from, () => to));
}

/* ------------------------------------------------------------------------------------------------ main */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sound-test-'));
let real = null;
head('1. the battery on the real modules (mixer, director, panel helpers)');
{
  real = await loadSet(JS);
  const res = await battery(real);
  for (const r of res) C.ok(r.ok, r.name, r.detail);
  console.log('   ' + res.filter((r) => r.ok).length + '/' + res.length + ' battery checks pass');
  global.__realNames = res.map((r) => r.name);
}

head('2. static checks');
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const f of ['audio_mixer.js', 'music_director.js', 'sound_panel.js', 'sound_system.js']) {
    const src = strip(fs.readFileSync(path.join(JS, f), 'utf8'));
    const imports = [...src.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
    C.ok(imports.every((i) => i.startsWith('./')) && !/https?:\/\//.test(src.replace(/['"`]https?:\/\/(?:www\.w3\.org|localhost)[^'"`]*['"`]/g, '')), 'static: ' + f + ' imports only first-party relative modules (' + imports.join(', ') + ')');
    C.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|importScripts|eval\(|new Function\(/.test(src.replace(/fetchRom\(/g, '')), 'static: ' + f + ' has no network call, eval or Function constructor of its own');
  }
  const mix = strip(fs.readFileSync(path.join(JS, 'audio_mixer.js'), 'utf8'));
  C.ok((mix.match(/new C\(/g) || []).length === 2 && !/new\s+(webkit)?AudioContext\s*\(/.test(mix), 'static: the mixer constructs a context only inside its context factory (two calls: with and without options)');
  for (const f of ['sound_panel.js', 'music_director.js', 'sound_system.js']) C.ok(!/new\s+(webkit)?AudioContext\s*\(|new\s+C\(/.test(strip(fs.readFileSync(path.join(JS, f), 'utf8'))), 'static: ' + f + ' never constructs an AudioContext');
  C.ok(typeof globalThis.AudioContext === 'undefined' && typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined', 'static: Node has no window / document / AudioContext, and importing all four modules above still worked (import-safe)');
  let imported = false; try { await import(pathToFileURL(path.join(JS, 'sound_system.js')).href); imported = true; } catch (e) { console.log(e.message); }
  C.ok(imported, 'static: sound_system.js (which imports cries.js, input.js and the three modules) imports in plain Node');
}

if (!ARGS.has('--no-mutants')) {
  head('3. mutants: each must fail its NAMED check; the unmutated twin stays quiet');
  const MUTANTS = [
    { id: 'M1 persistence write removed', file: 'audio_mixer.js', from: "try { st.setItem(AUDIO_KEY, JSON.stringify({ v: 1, master: s.master, music: s.music, fx: s.fx, muted: !!s.muted, soundtrack: s.soundtrack })); return true; } catch (_e) { return false; }", to: 'return true;', expect: 'mixer: volumes, mute and soundtrack are stored in arena.audio and a NEW mixer reads them back' },
    { id: 'M38 the director ignores effects when no song is wanted (Off leaves the engine unloaded)', file: 'music_director.js', from: 'if (!D.want) { stopNow(); if (effects) await ensureMusic(); return; }', to: 'if (!D.want) { stopNow(); return; }', expect: 'director: with effects:true the engine loads once the sound can play although NO song is wanted (and an effect then plays); without it the engine stays unloaded; nothing loads before the visitor has acted' },
    { id: 'M39 a tab that loaded hidden never gets its early try', file: 'audio_mixer.js', from: 'else if (earlyStart && S.detach.length && !S.settings.muted && !S.ctx && !S.ctxError) unlock();', to: '', expect: 'early start: a tab that LOADED hidden gets its early try the moment it is shown (autoplay allowed: running at once; blocked: a suspended context, then the first gesture starts it); a muted one and a never-attached mixer still wait' },
    { id: 'M40 the early try on show ignores a mixer that was never attached', file: 'audio_mixer.js', from: 'earlyStart && S.detach.length && ', to: 'earlyStart && ', expect: 'early start: a tab that LOADED hidden gets its early try the moment it is shown (autoplay allowed: running at once; blocked: a suspended context, then the first gesture starts it); a muted one and a never-attached mixer still wait' },
    { id: 'M41 the early try on show ignores a muted visitor', file: 'audio_mixer.js', from: 'earlyStart && S.detach.length && !S.settings.muted', to: 'earlyStart && S.detach.length', expect: 'early start: a tab that LOADED hidden gets its early try the moment it is shown (autoplay allowed: running at once; blocked: a suspended context, then the first gesture starts it); a muted one and a never-attached mixer still wait' },
    { id: 'M30 the early start does nothing', file: 'audio_mixer.js', from: 'if (earlyStart && !S.settings.muted && !S.hidden && !S.ctx && !S.ctxError) unlock();', to: 'if (false) unlock();', expect: 'early start, browser BLOCKS autoplay: the context is created at attach() but stays suspended (nothing can play), a prompt is still wanted, the gesture listeners stay armed' },
    { id: 'M31 the early start ignores a muted visitor', file: 'audio_mixer.js', from: 'if (earlyStart && !S.settings.muted && !S.hidden', to: 'if (earlyStart && !S.hidden', expect: 'early start: a muted visitor and a hidden tab get nothing at attach() (their first gesture / being shown still starts it)' },
    { id: 'M32 the early start ignores a hidden tab', file: 'audio_mixer.js', from: 'if (earlyStart && !S.settings.muted && !S.hidden', to: 'if (earlyStart && !S.settings.muted', expect: 'early start: a muted visitor and a hidden tab get nothing at attach() (their first gesture / being shown still starts it)' },
    { id: 'M33 the starting master volume is 0.7 again', file: 'audio_mixer.js', from: 'v: 1, master: 0.5, music: 0.6, fx: 0.8, muted: false, soundtrack: \'soulgold\' });      //', to: 'v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: false, soundtrack: \'soulgold\' });      //', expect: 'mixer: defaults (nothing stored) are master 0.5, music 0.6, fx 0.8, not muted, soulgold' },
    { id: 'M34 the gain law moves with the starting volume (anchored on DEFAULTS, not UNITY)', file: 'audio_mixer.js', from: "v0 = bus === 'music' ? UNITY.music : bus === 'fx' ? UNITY.fx : UNITY.master;", to: "v0 = bus === 'music' ? DEFAULTS.music : bus === 'fx' ? DEFAULTS.fx : DEFAULTS.master;", expect: 'mixer: at the UNITY slider positions (0.7 / 0.6 / 0.8) every bus has gain exactly 1.0 (the real game\'s own level), and a stored 0.7 master is unity' },
    { id: 'M35 a browser with no audio is still asked to click', file: 'audio_mixer.js', from: '!running() && !S.ctxError;', to: '!running();', expect: 'early start: a browser with no Web Audio is not asked to click for nothing (no prompt wanted)' },
    { id: 'M36 a first touch is not armed', file: 'audio_mixer.js', from: "'pointerup', 'touchstart', 'touchend'];", to: "'pointerup', 'touchend'];", expect: 'mixer: attach() listens for exactly keydown, mousedown, pointerdown, pointerup, touchstart, touchend' },
    { id: 'M37 a stored choice is rewritten at construction', file: 'audio_mixer.js', from: "if (read.source === 'migrated' || read.source === 'repaired' || read.source === 'invalid') persist();", to: 'persist();', expect: 'mixer: a STORED choice always wins and is never overwritten: master 0.7 / muted stay as stored, nothing is written at construction, only the absent fields take the new defaults' },
    { id: 'M2 mute is a no-op', file: 'audio_mixer.js', from: 'const next = !!m;\n    if (S.settings.muted === next) return next;\n    S.settings.muted = next;', to: 'const next = !!m;\n    return next;\n    S.settings.muted = next;', expect: 'mixer: MUTE ramps the master to exactly 0 and leaves the music and fx buses where they were' },
    { id: 'M3 gain law is linear', file: 'audio_mixer.js', from: 'if (x <= v0) return (x / v0) * (x / v0);', to: 'if (x <= v0) return x / v0;', expect: 'mixer: gain law: 0 -> 0, the default position -> 1.0, half the default -> 0.25 (square law below), 1.0 -> +3 dB, clamped (1.7 -> +3 dB, -3 -> 0, NaN -> 0), for each bus' },
    { id: 'M23 the soft limiter is not inserted', file: 'audio_mixer.js', from: "if (typeof ctx.createWaveShaper === 'function') { try {", to: "if (false) { try {", expect: 'mixer: the graph is music->master, fx->master, master->limiter, limiter->destination and nothing else' },
    { id: 'M24 the limiter curve is the identity', file: 'audio_mixer.js', from: 'ws.curve = limiterCurve();', to: 'ws.curve = Float32Array.from({ length: 4097 }, (_v, i) => -1 + (2 * i) / 4096);', expect: 'mixer: the soft limiter is a WaveShaper whose curve is limiterCurve() (4097 points, identity under the knee, never above the ceiling) with no oversampling' },
    { id: 'M4 context created at construction', file: 'audio_mixer.js', from: "if (read.source === 'migrated' || read.source === 'repaired' || read.source === 'invalid') persist();", to: "if (read.source === 'migrated' || read.source === 'repaired' || read.source === 'invalid') persist();\n  try { S.ctx = makeContext(); if (S.ctx) buildGraph(S.ctx); } catch (_e) { /* mutant */ }", expect: 'mixer: NO AudioContext exists before the first activation (construct, attach, volume, mute, soundtrack, duck, hidden)' },
    { id: 'M5 migration is repeated every load', file: 'audio_mixer.js', from: "if (text !== null && text !== undefined) {\n    if (typeof text", to: "if (false) {\n    if (typeof text", expect: 'mixer: arena.audio wins over arena.sound when both exist' },
    { id: 'M6 the Escape key counts as an activation', file: 'audio_mixer.js', from: "if (e && e.type === 'keydown' && e.key === 'Escape') return;", to: '', expect: 'mixer: Escape, a touch pointerdown and a mouse pointerup are NOT activations (no context)' },
    { id: 'M7 a hidden tab does not suspend', file: 'audio_mixer.js', from: "if (next) { clearSuspendTimer(); safeSuspend(); emit('hidden'); }", to: "if (next) { emit('hidden'); }", expect: 'mixer: a hidden tab suspends the context at once; coming back resumes it' },
    { id: 'M8 the sliders share one bus', file: 'audio_mixer.js', from: "for (const b of BUSES) moveParam(S.nodes[b] && S.nodes[b].gain, t[b], S.ctx, immediate, rampMs / 1000);", to: "for (const b of BUSES) moveParam(S.nodes[b] && S.nodes[b].gain, t.music, S.ctx, immediate, rampMs / 1000);", expect: 'mixer: each bus slider moves ONLY its own bus (music 0.5 -> music node (0.5/0.6)^2; master and fx untouched)' },
    { id: 'M9 unmute forgets to resume the context', file: 'audio_mixer.js', from: "else { clearSuspendTimer(); safeResume(); applyGains(false); }\n    }\n    emit('mute'", to: "else { clearSuspendTimer(); applyGains(false); }\n    }\n    emit('mute'", expect: 'mixer: UNMUTE resumes the context and ramps the master back to its slider position (not 1)' },
    { id: 'M10 the director plays before the visitor has acted', file: 'music_director.js', from: 'if (!mixer.canPlay()) { pauseNow(); return; }', to: 'if (false) { pauseNow(); return; }', expect: 'director: NOTHING is loaded or played before the visitor has acted (no context): no engine, no play' },
    { id: 'M11 the director restarts a song that is already playing', file: 'music_director.js', from: 'if (D.cur && D.cur.index === r.song.index && D.cur.soundtrack === st) {', to: 'if (false) {', expect: 'director: FALLBACKS on Ultra Violet (no battle_hard, no editor, no preview): hard -> normal, editor -> hub, preview -> hub' },
    { id: 'M12 no fallback along the battle chain', file: 'music_director.js', from: "battle_hard: ['battle_hard', 'battle_normal', 'battle_easy'],", to: "battle_hard: ['battle_hard'],", expect: 'director: FALLBACKS on Ultra Violet (no battle_hard, no editor, no preview): hard -> normal, editor -> hub, preview -> hub' },
    { id: 'M13 the jingle never hands over to the result music', file: 'music_director.js', from: 'if (w && w.then) { D.want = { key: w.then }; sync(); }', to: '', expect: 'director: result(win) plays the victory JINGLE first; when the jingle ENDS the result music starts; result(lose) the same with defeat' },
    { id: 'M14 mute does not pause the song', file: 'music_director.js', from: "if (ev.type === 'unlock' || ev.type === 'state' || ev.type === 'mute' || ev.type === 'hidden' || ev.type === 'visible') sync();", to: "if (ev.type === 'unlock' || ev.type === 'state' || ev.type === 'hidden' || ev.type === 'visible') sync();", expect: 'director: MUTE pauses the song, UNMUTE resumes it (no new play)' },
    { id: 'M15 effects ignore the mute', file: 'music_director.js', from: "if (!mixer.canPlay() || !D.music || !Number.isInteger(index)", to: "if (!D.music || !Number.isInteger(index)", expect: 'director: an effect is a NO-OP before the first activation, while muted, in a hidden tab, and for a key the soundtrack lacks' },
    { id: 'M17 a slider maps one percent off', file: 'sound_panel.js', from: 'const v = fromPercent(e.target.value); mixer.setVolume(bus, v); paintOne(bus);', to: 'const v = fromPercent(Number(e.target.value) + 1); mixer.setVolume(bus, v); paintOne(bus);', expect: 'panel DOM: a slider input event sets ITS bus (music 35 -> 0.35, the fx and master untouched) and the readout' },
    { id: 'M18 Esc is not consumed', file: 'sound_panel.js', from: 'e.preventDefault(); e.stopPropagation(); api.close(); } });', to: 'api.close(); } });', expect: 'panel DOM: Esc inside closes in ONE press and is consumed (preventDefault + stopPropagation); Close, the second Close and a backdrop click close too; onClose runs each time' },
    { id: 'M19 every slider plays the test cry on release', file: 'sound_panel.js', from: "onChange: () => { if (touch) return; if (bus === 'fx' && typeof opts.onTest === 'function') opts.onTest('fx'); },", to: "onChange: () => { if (touch) return; if (typeof opts.onTest === 'function') opts.onTest('fx'); },", expect: 'panel DOM: releasing the Effects slider plays the test cry; releasing Master or Music does not' },
    { id: 'M20 the wheel steps the wrong way', file: 'sound_panel.js', from: 'nudge(bus, acc < 0 ? 1 : -1); acc -= Math.sign(acc) * 100;', to: 'nudge(bus, acc < 0 ? -1 : 1); acc -= Math.sign(acc) * 100;', expect: 'panel DOM: the wheel over a slider row steps 5% per notch (a small trackpad delta accumulates) and prevents the page scroll' },
    { id: 'M21 the hold never repeats', file: 'sound_panel.js', from: 'holdTimer = setTimeout(() => { holdInt = setInterval(() => nudge(bus, dir), HOLD.intervalMs); }, HOLD.delayMs);', to: '', expect: 'panel DOM: HOLDING + repeats after 400 ms every 90 ms and stops on pointerup / leave (fake timers)' },
    { id: 'M22 a cancelled touch leaves the thumb where the finger jumped it', file: 'sound_panel.js', from: 'onPointercancel: () => { if (touch) { touch = null; paintOne(bus); } },', to: 'onPointercancel: () => { touch = null; },', expect: 'panel DOM: a TOUCH is applied only as a tap (pointerup) or after it moved sideways; a vertical scroll that starts on a slider (pointercancel) puts the thumb back and changes nothing; a mouse is applied at once' },
    { id: 'M16 a slider step of 7', file: 'sound_panel.js', from: 'const step = big ? VOLUME_STEP * 2 : VOLUME_STEP;', to: 'const step = big ? VOLUME_STEP * 2 : 7;', expect: 'panel: stepPercent moves by 5 (10 for a "big" press), stays a multiple of 5 and clamps at 0 and 100' },
  ];
  // the unmutated twin: copied the same way, no change, must pass every check
  {
    const twin = copySet(path.join(TMP, 'twin')); const res = await battery(await loadSet(twin));
    C.ok(res.every((r) => r.ok), 'mutants: the unmutated TWIN (a plain copy of the three modules) passes all ' + res.length + ' battery checks', res.filter((r) => !r.ok).map((r) => r.name).join('; '));
  }
  for (const m of MUTANTS) {
    const dir = copySet(path.join(TMP, m.id.split(' ')[0]));
    try { mutate(dir, m.file, m.from, m.to); } catch (e) { C.ok(false, 'mutant ' + m.id + ' could not be applied', e.message); continue; }
    let res;
    try { res = await battery(await loadSet(dir)); } catch (e) { C.ok(false, 'mutant ' + m.id + ' broke the harness', e.message); continue; }
    const failed = res.filter((r) => !r.ok).map((r) => r.name);
    C.ok(failed.includes(m.expect), 'mutant ' + m.id + ' trips its named check', 'failed: ' + failed.join(' | ').slice(0, 600));
  }
}

head('4. the shared contract against the REAL music_map.js / music.js (SKIPPED LOUDLY when a module has not landed)');
{
  const have = (f) => fs.existsSync(path.join(JS, f));
  let skipped = 0;
  if (!have('music_map.js')) { skipped++; console.log('SKIP (counted): pokemonarena/js/music_map.js does not exist yet; the director and panel were only tested against the stand-in map'); }
  else {
    const map = await import(pathToFileURL(path.join(JS, 'music_map.js')).href + '?c=1');
    C.ok(J(map.SOUNDTRACKS) === J(real.mixer.SOUNDTRACK_IDS), 'contract: music_map.SOUNDTRACKS equals the mixer\'s SOUNDTRACK_IDS', J(map.SOUNDTRACKS));
    C.ok(Array.isArray(map.MUSIC_KEYS) && typeof map.songFor === 'function' && map.ROM_PROFILES && map.ROM_PROFILES.soulgold && map.ROM_PROFILES.ultraviolet, 'contract: exports MUSIC_KEYS, songFor, ROM_PROFILES{soulgold,ultraviolet}');
    // the keys the pages / director ask for (sound_system.js battleFrame, boot.js, editor_app.js, music_director.js result()):
    const bgm = ['hub', 'editor', 'preview', 'battle_easy', 'battle_normal', 'battle_hard', 'victory_sting', 'defeat', 'result_win', 'result_lose'];
    const sfx = ['se_cursor', 'se_select', 'se_back', 'se_hit_normal', 'se_hit_super', 'se_hit_weak', 'se_faint', 'se_ball_open'];
    const allKeys = map.ALL_KEYS || [...map.MUSIC_KEYS, ...(map.SFX_KEYS || [])];
    const missing = [...bgm, ...sfx].filter((k) => !allKeys.includes(k));
    C.ok(missing.length === 0, 'contract: every key the pages ask for exists in music_map (' + bgm.length + ' music keys + ' + sfx.length + ' sound-effect keys)', 'missing: ' + missing.join(', '));
    for (const st of map.SOUNDTRACKS) for (const k of allKeys) { const s = map.songFor(st, k); if (s !== null && !(Number.isInteger(s.index) && typeof s.loops === 'boolean' && typeof s.jingle === 'boolean' && typeof s.label === 'string')) C.ok(false, 'contract: songFor(' + st + ',' + k + ') has the shape {index,loops,jingle,label}', J(s)); }
    C.ok(true, 'contract: every songFor(soundtrack, key) over every key is null or {index,loops,jingle,label}');
    // SoulGold must have a song for everything the pages ask for; Ultra Violet may fall back (resolveSong) but must have SOMETHING for the screens
    const noSG = [...bgm, ...sfx].filter((k) => map.songFor('soulgold', k) === null);
    C.ok(noSG.length === 0, 'contract: SoulGold has a song for every key the pages ask for', 'null: ' + noSG.join(', '));
    if (typeof map.resolveSong === 'function') {
      const noUV = ['hub', 'editor', 'preview', 'battle_easy', 'battle_normal', 'battle_hard', 'result_win', 'result_lose'].filter((k) => map.resolveSong('ultraviolet', k) === null);
      C.ok(noUV.length === 0, 'contract: Ultra Violet resolves (directly or through the map\'s fallbacks) every screen key', 'unresolved: ' + noUV.join(', '));
    } else C.ok(false, 'contract: music_map.js exports resolveSong (the director uses its fallback chains)');
    // the facts the director relies on: a fanfare that ENDS must not loop; the keys it plays as looping music must loop
    const bad = [];
    for (const st of map.SOUNDTRACKS) for (const k of ['hub', 'editor', 'preview', 'battle_easy', 'battle_normal', 'battle_hard', 'result_win', 'result_lose']) { const s = map.songFor(st, k); if (s && !s.loops) bad.push(st + ':' + k); }
    C.ok(bad.length === 0, 'contract: every screen / battle / result key that should play on a loop is a looping song', 'not looping: ' + bad.join(', '));
    for (const st of map.SOUNDTRACKS) for (const k of ['defeat', 'victory_sting']) { const d = map.songFor(st, k); if (d) C.ok(!d.loops && d.jingle, 'contract: ' + st + ' "' + k + '" is a fanfare that ENDS (the director waits for its end to start the result music)', J(d)); }
    for (const st of map.SOUNDTRACKS) for (const k of ['se_cursor', 'se_select', 'se_hit_normal']) { const s = map.songFor(st, k); if (s) C.ok(!s.loops, 'contract: ' + st + ' ' + k + ' is a one-shot effect (does not loop)', J(s)); }
  }
  if (!have('music.js')) { skipped++; console.log('SKIP (counted): pokemonarena/js/music.js does not exist yet; the director was only tested against the stand-in engine'); }
  else {
    const mus = await import(pathToFileURL(path.join(JS, 'music.js')).href + '?c=1');
    C.ok(typeof mus.createMusic === 'function' && typeof mus.renderSong === 'function' && typeof mus.listSongs === 'function', 'contract: music.js exports createMusic, renderSong, listSongs');
  }
  console.log('   contract sections skipped: ' + skipped);
  global.__skipped = skipped;
}

head('5. the REAL music.js + the REAL music_map.js through the director, the mixer and the recording AudioContext double (SKIPPED LOUDLY when a module or the ROM is absent)');
{
  const have = (f) => fs.existsSync(path.join(JS, f));
  if (!have('music.js') || !have('music_map.js') || !fs.existsSync(L.ROM_PATH)) { global.__skipped = (global.__skipped || 0) + 1; console.log('SKIP (counted): music.js / music_map.js / the SoulGold ROM is not present; the director has not been run against the real engine'); }
  else {
    const map = await import(pathToFileURL(path.join(JS, 'music_map.js')).href + '?r=1');
    const mus = await import(pathToFileURL(path.join(JS, 'music.js')).href + '?r=1');
    const rom = L.readRom();
    const r = await unlocked(real); const errors = [];
    const resolve = (st, key) => { const x = map.resolveSong(st, key); return x ? { key: x.key, song: x } : null; };
    const d = real.director.createDirector({ mixer: r.mixer, songFor: map.songFor, resolve, loadMusic: async () => mus, romFor: async () => rom });
    const edges = () => r.log.connects.map((e) => e.join('>'));
    const ids = r.log.gains.slice(0, 3).map((g) => g.id);            // master, music, fx
    d.set('hub'); await new Promise((res) => setTimeout(res, 1200));
    const s1 = d.state(); const hub = map.songFor('soulgold', 'hub');
    C.ok(!s1.error && s1.engine && s1.cur && s1.cur.index === hub.index && s1.cur.key === 'hub', 'real engine: the director asks the REAL music_map for "hub" (index ' + hub.index + ') and the REAL createMusic plays it without an error', J({ error: s1.error, cur: s1.cur }));
    C.ok(r.log.createBufferSource > 0 && r.log.start > 0, 'real engine: the engine scheduled audio buffers on the (recording) context: ' + r.log.createBufferSource + ' sources, ' + r.log.start + ' starts');
    C.ok(r.log.gains.length > 3 && edges().some((e) => e.endsWith('>' + ids[1])), 'real engine: the BGM is routed INTO the music bus node (an edge to its id exists)');
    const fxBefore = edges().filter((e) => e.endsWith('>' + ids[2])).length;
    d.playSfx('se_select'); d.playEffectIndex(map.songFor('soulgold', 'se_hit_super').index, -0.5);
    await new Promise((res) => setTimeout(res, 100));
    const sf = d.state().sfx;
    C.ok(sf.length === 2 && sf.every((x) => x.played === true), 'real engine: two effects (se_select, and se_hit_super by index with pan -0.5) are accepted by the real playEffect', J(sf));
    C.ok(edges().filter((e) => e.endsWith('>' + ids[2])).length > fxBefore, 'real engine: the effects are routed into the FX bus node (new edges to its id)');
    d.battle('hard'); await new Promise((res) => setTimeout(res, 800));
    const s2 = d.state();
    C.ok(!s2.error && s2.cur && s2.cur.index === map.songFor('soulgold', 'battle_hard').index, 'real engine: battle_hard crossfades in (index ' + map.songFor('soulgold', 'battle_hard').index + ')', J(s2.cur));
    r.doc.hidden = true; r.mixer._onVisibility(); await flush();
    C.ok(d.state().paused === true && r.log.ctxs[0].state === 'suspended', 'real engine: a hidden tab pauses the real engine and suspends the context');
    r.doc.hidden = false; r.mixer._onVisibility(); await flush(); await flush();
    C.ok(d.state().paused === false && r.log.ctxs[0].state === 'running' && d.state().cur.index === map.songFor('soulgold', 'battle_hard').index, 'real engine: coming back resumes the same song (no restart)');
    d.dispose();
    r.mixer.setSoundtrack('ultraviolet'); await new Promise((res) => setTimeout(res, 100));
    const uvRom = fs.existsSync(path.join(root, 'gba', 'gbaWasm', 'roms', 'pokemonUltraViolet.gba')) ? new Uint8Array(fs.readFileSync(path.join(root, 'gba', 'gbaWasm', 'roms', 'pokemonUltraViolet.gba'))) : null;
    if (uvRom) {
      const d2 = real.director.createDirector({ mixer: r.mixer, songFor: map.songFor, resolve, loadMusic: async () => mus, romFor: async (st) => (st === 'ultraviolet' ? uvRom : rom) });
      d2.set('hub'); await new Promise((res) => setTimeout(res, 1500));
      const u = d2.state(); const uvHub = map.songFor('ultraviolet', 'hub');
      C.ok(!u.error && u.cur && u.cur.index === uvHub.index && u.cur.soundtrack === 'ultraviolet', 'real engine: the Ultra Violet ROM + its map entry play through the same director (hub = song ' + uvHub.index + ')', J({ error: u.error, cur: u.cur }));
      d2.dispose();
    } else { global.__skipped = (global.__skipped || 0) + 1; console.log('SKIP (counted): the Ultra Violet ROM is not in gba/gbaWasm/roms'); }
    r.mixer.destroy();
    // the same engine on MU1's own recording double (music_test_double.js: a running context with a manual clock), behind OUR mixer and director
    if (have('music_test_double.js')) {
      const { createFakeAudio } = await import(pathToFileURL(path.join(JS, 'music_test_double.js')).href + '?r=1');
      const fake = createFakeAudio();
      const scope2 = makeScope(); const doc2 = Object.assign(makeScope(), { hidden: false });
      const mixer2 = real.mixer.createMixer({ window: scope2, document: doc2, storage: memStore(), createContext: () => fake.ctx });
      mixer2.attach(); scope2.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush();
      const d3 = real.director.createDirector({ mixer: mixer2, songFor: map.songFor, resolve, loadMusic: async () => mus, romFor: async () => rom });
      d3.set('hub'); await new Promise((res) => setTimeout(res, 1200)); fake.advance(2);
      const c = fake.counts(), s3 = d3.state();
      C.ok(!s3.error && s3.cur && s3.cur.key === 'hub' && c.createBufferSource > 0 && fake.scheduledSeconds() > 0, 'real engine on MU1\'s music_test_double.js behind our mixer: the hub song is scheduled (' + c.createBufferSource + ' sources, ' + Math.round(fake.scheduledSeconds() * 10) / 10 + ' s of audio) and nothing errors', J({ error: s3.error, counts: c }));
      d3.dispose(); mixer2.destroy();
    } else { global.__skipped = (global.__skipped || 0) + 1; console.log('SKIP (counted): music_test_double.js is not present'); }
    C.ok(errors.length === 0, 'real engine: no unhandled error');
  }
}

head('6. sound_system.js: the low-HP warning (the game\'s red zone, once per stay, stops when it is over) and the menu error buzz; the same battery on MUTANTS');
{
  const SYS_SONGS = { soulgold: { ...STUB_SONGS.soulgold, se_lowhp: { index: 290, loops: false, jingle: true, label: 'SG low hp' }, se_error: { index: 291, loops: false, jingle: true, label: 'SG error' }, se_select: { index: 201, loops: false, jingle: true, label: 'SG select' } }, ultraviolet: STUB_SONGS.ultraviolet };
  const copyAll = (dest) => { fs.mkdirSync(dest, { recursive: true }); for (const f of fs.readdirSync(JS)) if (f.endsWith('.js')) fs.copyFileSync(path.join(JS, f), path.join(dest, f)); return dest; };
  const battleUi = await import(pathToFileURL(path.join(JS, 'battle_ui.js')).href + '?s6=1');
  // a scene stand-in with exactly what sound_system.js reads: mode, state().player, S.disp[*].barCurr
  const stubScene = () => {
    const S = { mode: 'action', disp: [{ name: 'MINE', hp: 30, maxHp: 30, visible: true, barCurr: undefined }, { name: 'FOE', hp: 30, maxHp: 30, visible: true, barCurr: undefined }], refuse: false, calls: [] };
    const scene = { S, hooks: {}, get mode() { return S.mode; }, state() { const d = S.disp[0]; return { mode: S.mode, winner: null, cursor: 0, player: d ? { name: d.name, hp: d.hp, max: d.maxHp, visible: d.visible } : null, foe: S.disp[1] ? { name: S.disp[1].name, hp: S.disp[1].hp, max: S.disp[1].maxHp, visible: true } : null }; },
      press(a) { S.calls.push(a); if (a === 'a' && S.refuse) { S.mode = 'steps'; } return true; }, pointer() { return true; } };
    return scene;
  };
  async function sysBattery(dir) {
    const R = []; const step = async (name, fn) => { let ok = false, why = ''; try { ok = !!(await fn()); } catch (e) { why = 'threw ' + e.message; } R.push({ name, ok, why }); };
    const SS = await importFrom(dir, 'sound_system.js');
    const make = async ({ unlock = true } = {}) => {
      const log = {}; const scope = makeScope(); installFakeAudio(scope, log);
      const FD = fakeDom(); Object.assign(FD.doc, makeScope(), { hidden: false });
      const mlog = {}; const music = makeStubMusic(mlog);
      const sys = SS.createSoundSystem({ window: scope, document: FD.doc, storage: memStore(), noPrompt: true, page: 'battle', loadMusic: async () => music, loadMap: async () => makeStubMap(SYS_SONGS) });
      if (unlock) { scope.dispatch('keydown', { type: 'keydown', key: 'a' }); await flush(); }
      sys.setRom({ bytes: new Uint8Array(8), pack: { species: [] } });
      mlog.effectStops = []; mlog.starts = [];
      const origCreate = music.createMusic;
      music.createMusic = async (o) => { const m = await origCreate(o); m.playEffect = (index, oo) => { mlog.effect.push({ index, pan: oo && oo.pan }); mlog.starts.push(index); return { index, stop() { mlog.effectStops.push(index); } }; }; return m; };
      if (unlock) { sys.director.set('hub'); for (let i = 0; i < 6; i++) await flush(); }
      return { sys, mlog, scope, log };
    };
    const beeps = (mlog) => mlog.starts.filter((i) => i === 290).length;
    const stops = (mlog) => mlog.effectStops.filter((i) => i === 290).length;
    const hp = (sc, h, m = 30, extra = {}) => { Object.assign(sc.S.disp[0], { hp: h, maxHp: m, visible: true, barCurr: undefined }, extra); };

    /* ---- the red-zone rule (pure) ---- */
    const L = SS.isLowHp;
    await step('low-HP rule: the game\'s red zone (GetHPBarLevel): alive, max > 1, HP <= max/5 (integer): 1/100 yes, 20/100 yes, 21/100 no, 0/100 no (fainted), 100/100 no, 1/1 no, 1/2 no, 1/5 yes, 2/5 no, 6/30 yes, 7/30 no', () => [[1, 100, true], [20, 100, true], [21, 100, false], [0, 100, false], [100, 100, false], [1, 1, false], [1, 2, false], [1, 5, true], [2, 5, false], [6, 30, true], [7, 30, false], [3, 19, true], [4, 19, false]].every(([h, m, e]) => L(h, m) === e));
    await step('low-HP rule: hostile values are never red (NaN, undefined, strings, negative HP, HP above max)', () => L(NaN, 30) === false && L(undefined, 30) === false && L(5, undefined) === false && L('x', 30) === false && L(-3, 30) === false && L(40, 30) === false && L(Infinity, 30) === false);
    await step('low-HP rule agrees with the battle screen\'s own HP-bar colour (battle_ui.hpBarColor, ported from the same ROM function) for every HP of every max HP 1..400', () => { for (let m = 1; m <= 400; m++) for (let h = 0; h <= m; h++) { if (L(h, m) !== (h > 0 && battleUi.hpBarColor(h, m) === 'hpRed')) return false; } return true; });

    /* ---- the warning through the system ---- */
    await step('low-HP: the beep (se_lowhp, song 290 here) starts ONCE when the player\'s active Pokemon enters the red zone; no beep while it is full, green or yellow', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); sys.battleFrame(sc, 'normal', true);
      hp(sc, 30); sys.battleFrame(sc, 'normal', true); hp(sc, 20); sys.battleFrame(sc, 'normal', true); hp(sc, 7); sys.battleFrame(sc, 'normal', true);
      const quiet = beeps(mlog) === 0; hp(sc, 6); sys.battleFrame(sc, 'normal', true);
      return quiet && beeps(mlog) === 1 && sys.state().lowHp.on === true && sys.state().frameError === null;
    });
    await step('low-HP: it is NOT repeated while the Pokemon stays in the red zone (60 frames, then HP going down inside the zone)', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); hp(sc, 5); for (let i = 0; i < 60; i++) sys.battleFrame(sc, 'normal', true);
      hp(sc, 3); for (let i = 0; i < 20; i++) sys.battleFrame(sc, 'normal', true); hp(sc, 1); sys.battleFrame(sc, 'normal', true);
      return beeps(mlog) === 1;
    });
    await step('low-HP: it STOPS (the game\'s m4aSongNumStop) when HP is healed above the zone, and starts again at the next entry', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); hp(sc, 5); sys.battleFrame(sc, 'normal', true); const a = beeps(mlog) === 1 && stops(mlog) === 0;
      hp(sc, 20); sys.battleFrame(sc, 'normal', true); const b = stops(mlog) === 1 && sys.state().lowHp.on === false;
      hp(sc, 4); sys.battleFrame(sc, 'normal', true); return a && b && beeps(mlog) === 2;
    });
    await step('low-HP: it waits for the HP bar to stop moving (the game starts it one frame after the bar\'s last step): nothing while the bar is draining, the beep the frame it settles', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); hp(sc, 30); sys.battleFrame(sc, 'normal', true);
      hp(sc, 5, 30, { barCurr: 1300 }); for (let i = 0; i < 10; i++) sys.battleFrame(sc, 'normal', true); const during = beeps(mlog);
      sc.S.disp[0].barCurr = undefined; sys.battleFrame(sc, 'normal', true); return during === 0 && beeps(mlog) === 1;
    });
    await step('low-HP: a fainted Pokemon (HP 0, hidden) stops it; the replacement entering at full HP does not beep; a replacement that comes in red does', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); hp(sc, 4); sys.battleFrame(sc, 'normal', true); const a = beeps(mlog) === 1;
      hp(sc, 0, 30, { visible: false }); sys.battleFrame(sc, 'normal', true); const b = stops(mlog) === 1;
      hp(sc, 30); sys.battleFrame(sc, 'normal', true); const c = beeps(mlog) === 1;
      hp(sc, 2, 40); sys.battleFrame(sc, 'normal', true); return a && b && c && beeps(mlog) === 2;
    });
    await step('low-HP: a Pokemon that is not on the field (hidden, with HP left) does not beep', async () => { const { sys, mlog } = await make(); const sc = stubScene(); hp(sc, 4, 30, { visible: false }); for (let i = 0; i < 5; i++) sys.battleFrame(sc, 'normal', true); return beeps(mlog) === 0; });
    await step('low-HP: the result screen stops it, and so does leaving the page (pagehide)', async () => {
      const { sys, mlog, scope } = await make(); const sc = stubScene(); hp(sc, 4); sys.battleFrame(sc, 'normal', true);
      sc.S.mode = 'result'; sys.battleFrame(sc, 'normal', true); const a = stops(mlog) === 1;
      sc.S.mode = 'action'; sys.battleFrame(sc, 'normal', true); const again = beeps(mlog) === 2; scope.dispatch('pagehide', { type: 'pagehide' });
      return a && again && stops(mlog) === 2;
    });
    /* ---- the back / forward cache ---- */
    await step('page cache: pagehide stops the song and a pageshow FROM the cache brings the wanted song back (the battle page: straight from the director); a pageshow that is not from the cache brings nothing', async () => {
      const { sys, mlog, scope } = await make(); const p0 = mlog.play.length;
      scope.dispatch('pagehide', { type: 'pagehide', persisted: true }); await flush();
      const gone = sys.director.state().want === null;
      scope.dispatch('pageshow', { type: 'pageshow', persisted: false }); for (let i = 0; i < 4; i++) await flush();
      const still = sys.director.state().want === null && mlog.play.length === p0;
      scope.dispatch('pageshow', { type: 'pageshow', persisted: true }); for (let i = 0; i < 6; i++) await flush();
      const w = sys.director.state().want;
      scope.dispatch('pageshow', { type: 'pageshow', persisted: true }); for (let i = 0; i < 4; i++) await flush();
      return p0 === 1 && gone && still && !!w && w.key === 'hub' && mlog.play.length === 2 && mlog.play[1].index === 10 && sys.director.state().plays === 2;
    });
    await step('page cache: a MENU page gets back the song of the player\'s pick (not the screen\'s own), and a page with the menu music Off stays silent', async () => {
      const { sys, mlog, scope } = await make(); sys.menuMusic.set('editor'); for (let i = 0; i < 6; i++) await flush();
      const ed = mlog.play.length && mlog.play[mlog.play.length - 1].index === 11;
      sys.menuMusic.choose('battle_hard'); for (let i = 0; i < 6; i++) await flush();
      scope.dispatch('pagehide', { type: 'pagehide', persisted: true }); await flush(); const n0 = mlog.play.length;
      scope.dispatch('pageshow', { type: 'pageshow', persisted: true }); for (let i = 0; i < 6; i++) await flush();
      const picked = mlog.play.length === n0 + 1 && mlog.play[mlog.play.length - 1].index === 22 && sys.director.state().want.key === 'battle_hard';
      sys.menuMusic.choose('off'); for (let i = 0; i < 4; i++) await flush(); const n1 = mlog.play.length;
      scope.dispatch('pagehide', { type: 'pagehide', persisted: true }); await flush(); scope.dispatch('pageshow', { type: 'pageshow', persisted: true }); for (let i = 0; i < 6; i++) await flush();
      return !!ed && picked && sys.director.state().want === null && mlog.play.length === n1;
    });
    await step('page cache: destroy() removes the pagehide and pageshow listeners', async () => {
      const { sys, scope } = await make(); const n = scope.count('pagehide') + scope.count('pageshow'); sys.destroy();
      return n >= 2 && scope.count('pagehide') === 0 && scope.count('pageshow') === 0;
    });
    await step('menu music Off: the engine still loads (the menus\' sound effects play) with the changer on Off BEFORE the sound can start, and no song is played', async () => {
      const log = {}; const scope = makeScope(); scope.__autoplayStrict = true; installFakeAudio(scope, log); const FD = fakeDom(); Object.assign(FD.doc, makeScope(), { hidden: false });       // strict: the browser refuses until the visitor acts
      const mlog = {}; const music = makeStubMusic(mlog); const store = memStore({ 'arena.menumusic': JSON.stringify({ v: 1, pick: 'off' }) });
      const sys = SS.createSoundSystem({ window: scope, document: FD.doc, storage: store, noPrompt: true, page: 'hub', bar: false, loadMusic: async () => music, loadMap: async () => makeStubMap(SYS_SONGS) });
      sys.setRom({ bytes: new Uint8Array(8), pack: { species: [] } }); sys.menuMusic.set('hub'); for (let i = 0; i < 4; i++) await flush();
      const before = mlog.create.length;                                           // no gesture yet: nothing loads
      scope.__autoplayAllowed = true; scope.dispatch('keydown', { type: 'keydown', key: 'a' }); for (let i = 0; i < 8; i++) await flush();       // the browser now counts the key press
      const h = sys.director.playSfx('se_cursor');
      return before === 0 && mlog.create.length === 1 && mlog.play.length === 0 && sys.state().menuMusic.pick === 'off' && !!h && mlog.effect.length === 1 && mlog.effect[0].index === 200;
    });
    // EFFECTS ARE A PAGE OPTION: the hub and the battle page play effects, so with the menu music Off they still load the engine; the team editor plays none, so it loads nothing (no engine, and no
    // Ultra Violet ROM fetched for it). The `effects` option overrides the page's default either way.
    await step('menu music Off, effects are a page option: the hub and the battle page load the engine, the team editor loads nothing (Ultra Violet chosen: no ROM fetch either); the `effects` option overrides the default', async () => {
      const run = async (extra) => {
        const log = {}; const scope = makeScope(); scope.__autoplayAllowed = true; installFakeAudio(scope, log); const FD = fakeDom(); Object.assign(FD.doc, makeScope(), { hidden: false });
        let uv = 0; scope.__arenaSoundModules = { uvRom: async () => { uv++; return new Uint8Array(16777216); } };
        const mlog = {}; const music = makeStubMusic(mlog);
        const store = memStore({ 'arena.menumusic': JSON.stringify({ v: 1, pick: 'off' }), 'arena.audio': JSON.stringify({ v: 1, master: 0.5, music: 0.6, fx: 0.8, muted: false, soundtrack: 'ultraviolet' }) });
        const sys = SS.createSoundSystem({ window: scope, document: FD.doc, storage: store, noPrompt: true, bar: false, loadMusic: async () => music, loadMap: async () => makeStubMap(SYS_SONGS), ...extra });
        sys.setRom({ bytes: new Uint8Array(8), pack: { species: [] } }); sys.menuMusic.set('hub'); scope.dispatch('keydown', { type: 'keydown', key: 'a' }); for (let i = 0; i < 12; i++) await flush();
        return { created: mlog.create.length, plays: mlog.play.length, uv, engine: sys.state().director.engine };
      };
      const hub = await run({ page: 'hub' }), battle = await run({ page: 'battle' }), editor = await run({ page: 'editor' }), editorFx = await run({ page: 'editor', effects: true }), hubNoFx = await run({ page: 'hub', effects: false });
      return hub.created === 1 && hub.engine === true && hub.plays === 0 && hub.uv === 1 && battle.created === 1 && battle.plays === 0
        && editor.created === 0 && editor.engine === false && editor.plays === 0 && editor.uv === 0
        && editorFx.created === 1 && editorFx.uv === 1 && hubNoFx.created === 0 && hubNoFx.engine === false && hubNoFx.uv === 0;
    });
    await step('low-HP: only the PLAYER\'s Pokemon counts (the opponent in the red zone makes no beep)', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); sc.S.disp[1].hp = 2; for (let i = 0; i < 5; i++) sys.battleFrame(sc, 'normal', true); return beeps(mlog) === 0;
    });
    await step('low-HP: with the sound not yet unlocked (no gesture) nothing is played and nothing breaks; the warning is not queued for later', async () => {
      const { sys, mlog } = await make({ unlock: false }); const sc = stubScene(); hp(sc, 3); for (let i = 0; i < 5; i++) sys.battleFrame(sc, 'normal', true);
      return mlog.effect === undefined || (mlog.effect || []).length === 0 ? sys.state().frameError === null && sys.state().director.engine === false : false;
    });
    await step('low-HP: a scene without HP info (state() throws) is survived: frameError is recorded, the game goes on', async () => {
      const { sys } = await make(); const sc = stubScene(); sc.state = () => { throw new Error('boom'); }; sys.battleFrame(sc, 'normal', true); return typeof sys.state().frameError === 'string';
    });

    /* ---- the prompt's words ---- */
    await step('prompt text: BOTH variants say what to do (click, tap or press a key) and that a controller button cannot (the layout decides which one is shown); neither carries the old "(that is a browser rule)" clause; the short one is short', () => {
      const P = SS.PROMPT_TEXT; return /Click, tap or press/.test(P.long) && /Click, tap or press/.test(P.short) && /controller button cannot/i.test(P.long) && /controller button cannot/i.test(P.short) && !/browser rule/.test(P.long + P.short) && P.short.length < 80 && P.long.length < 140;
    });
    /* ---- hit / faint hooks ---- */
    await step('hooks: the effectiveness sound (se_hit_super / weak / normal = 204 / 205 / 203 here) plays at every damaging hit, EVEN AFTER the animator has delivered sounds of its own (it never delivers this one: it is the battle script\'s)', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); sys.hookScene(sc);
      sc.hooks.onSound(217, 0); sc.hooks.onSound(15, 0); const e0 = mlog.starts.length;
      sc.hooks.onHit(1, { eff: 8192 }); sc.hooks.onHit(1, { eff: 2048 }); sc.hooks.onHit(1, { eff: 4096 });
      return J(mlog.starts.slice(e0)) === J([204, 205, 203]) && sys.state().animSounds === true;
    });
    await step('hooks: a faint plays se_faint ONCE: the animator\'s own copy of the same sound arriving right after is dropped; other animator sounds still pass', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); sys.hookScene(sc);
      sc.hooks.onFaint(1, 25); const a = mlog.starts.filter((i) => i === 206).length === 1;
      sc.hooks.onSound(206, 0); const b = mlog.starts.filter((i) => i === 206).length === 1;
      sc.hooks.onSound(217, 0); const c = mlog.starts.filter((i) => i === 217).length === 1;
      sc.hooks.onSound(206, 0); const d = mlog.starts.filter((i) => i === 206).length === 2;          // a second animator copy is a second sound (only ONE duplicate is swallowed per hook call)
      return a && b && c && d;
    });
    await step('hooks: with no animator at all (a scene that only calls the hooks) hits, a faint and a send-out each make their sound', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); sys.hookScene(sc);
      sc.hooks.onHit(1, { eff: 4096 }); sc.hooks.onFaint(1, 25); sc.hooks.onSendOut(0, 25, {}); return J(mlog.starts) === J([203, 206, 207]);
    });

    /* ---- the menu error buzz ---- */
    await step('menu: START refused (effects contain { type: "blocked" }) answers se_error (song 291 here), NOT the select sound', async () => {
      const { sys, mlog } = await make(); sys.menuSfx('a', true, true, [{ type: 'blocked', reason: 'team-illegal' }]);
      return mlog.starts.join(',') === '291' && sys.state().menuSfx.slice(-1)[0] === 'se_error';
    });
    await step('menu: the same press without a refusal (no effects, a battle effect, a screen effect) plays the select sound; so does a press that only moves a cursor with no effects', async () => {
      const { sys, mlog } = await make(); sys.menuSfx('a', true, true, []); sys.menuSfx('a', true, true, [{ type: 'battle', mode: 'quick' }]); sys.menuSfx('a', true, true, [{ type: 'screen', path: 'quick' }]); sys.menuSfx('a', true, true);
      return mlog.starts.join(',') === '201,201,201,201';
    });
    await step('menu: the battle screen\'s own refusals (a move with no PP, a fainted Pokemon, "already in battle") play the SELECT sound only, never the error buzz (the real game does exactly that: oracle-verified)', async () => {
      const { sys, mlog } = await make(); const sc = stubScene(); sc.S.refuse = true; sc.S.mode = 'moves';
      sys.pressWithSfx(sc, 'a'); return mlog.starts.join(',') === '201' && sys.state().menuSfx.slice(-1)[0] === 'se_select';
    });
    await step('menu: input that is not in a menu (text advancing) is silent', async () => { const { sys, mlog } = await make(); sys.menuSfx('a', true, false, [{ type: 'blocked' }]); return mlog.starts.length === 0; });
    return R;
  }
  const sysMut = (tag, from, to) => { const d = copyAll(path.join(TMP, 'sys-' + tag)); mutate(d, 'sound_system.js', from, to); return d; };
  {
    const base = copyAll(path.join(TMP, 'sys-twin'));
    const res = await sysBattery(base);
    for (const r of res) C.ok(r.ok, r.name, r.why);
    C.ok(res.length >= 15, 'the sound_system battery ran ' + res.length + ' checks');
    // static wiring of the two page hunks and the music_map keys the system asks for
    const boot = fs.readFileSync(path.join(JS, 'boot.js'), 'utf8');
    C.ok(/soundSys\.menuSfx\(e\.action, [^;]*, true, fx\)/.test(boot) && /soundSys\.menuSfx\('a', true, true, fx\)/.test(boot), 'static: the hub passes the model\'s effects to menuSfx on BOTH the key / pad path and the click path (a refused START is heard as the error buzz on every device)');
    const bb = fs.readFileSync(path.join(JS, 'battle_boot.js'), 'utf8');
    C.ok(/battleFrame\(/.test(bb), 'static: the battle page calls battleFrame every frame (the low-HP warning rides on it)');
    const mapSrc = fs.existsSync(path.join(JS, 'music_map.js')) ? await import(pathToFileURL(path.join(JS, 'music_map.js')).href + '?s6=1') : null;
    if (mapSrc) C.ok(['soulgold', 'ultraviolet'].every((st) => ['se_lowhp', 'se_error', 'se_select'].every((k) => Number.isInteger((mapSrc.songFor(st, k) || {}).index))), 'contract: the REAL music_map has se_lowhp / se_error / se_select on both soundtracks, which are the keys the system plays', J(['se_lowhp', 'se_error'].map((k) => [k, mapSrc.songFor('soulgold', k).index, mapSrc.songFor('ultraviolet', k).index])));
  }
  if (!ARGS.has('--no-mutants')) {
    const SYSM = [
      { id: 'S1 the warning is never started', from: "const h = director.playSfx('se_lowhp');", to: 'const h = null;', expect: 'low-HP: the beep (se_lowhp, song 290 here) starts ONCE when the player\'s active Pokemon enters the red zone; no beep while it is full, green or yellow' },
      { id: 'S2 the warning repeats every frame', from: 'if (red && !S.low.on) {', to: 'if (red) {', expect: 'low-HP: it is NOT repeated while the Pokemon stays in the red zone (60 frames, then HP going down inside the zone)' },
      { id: 'S3 the warning is never stopped', from: '} else if (!red && S.low.on) stopLowHp();', to: '}', expect: 'low-HP: it STOPS (the game\'s m4aSongNumStop) when HP is healed above the zone, and starts again at the next entry' },
      { id: 'S4 the warning ignores the moving bar', from: "if (disp && disp.some((d) => d && d.barCurr !== undefined)) return;", to: '', expect: 'low-HP: it waits for the HP bar to stop moving (the game starts it one frame after the bar\'s last step): nothing while the bar is draining, the beep the frame it settles' },
      { id: 'S5 the red zone is a quarter', from: 'return h > 0 && m > 1 && h <= Math.trunc(m / 5);', to: 'return h > 0 && m > 1 && h <= Math.trunc(m / 4);', expect: 'low-HP rule: the game\'s red zone (GetHPBarLevel): alive, max > 1, HP <= max/5 (integer): 1/100 yes, 20/100 yes, 21/100 no, 0/100 no (fainted), 100/100 no, 1/1 no, 1/2 no, 1/5 yes, 2/5 no, 6/30 yes, 7/30 no' },
      { id: 'S6 a fainted Pokemon still counts', from: "const red = !!(p && p.visible !== false && st.mode !== 'result' && isLowHp(p.hp, p.max));", to: "const red = !!(p && st.mode !== 'result' && isLowHp(p.hp, p.max));", expect: 'low-HP: a Pokemon that is not on the field (hidden, with HP left) does not beep' },
      { id: 'S12 a fainted Pokemon (HP 0) is red', from: 'return h > 0 && m > 1 && h <= Math.trunc(m / 5);', to: 'return m > 1 && h <= Math.trunc(m / 5);', expect: 'low-HP rule: the game\'s red zone (GetHPBarLevel): alive, max > 1, HP <= max/5 (integer): 1/100 yes, 20/100 yes, 21/100 no, 0/100 no (fainted), 100/100 no, 1/1 no, 1/2 no, 1/5 yes, 2/5 no, 6/30 yes, 7/30 no' },
      { id: 'S7 the result screen keeps beeping', from: "st.mode !== 'result' && ", to: '', expect: 'low-HP: the result screen stops it, and so does leaving the page (pagehide)' },
      { id: 'S8 a refused START is not an error', from: "const refused = Array.isArray(effects) && effects.some((e) => e && ERROR_EFFECTS.includes(e.type));", to: 'const refused = false;', expect: 'menu: START refused (effects contain { type: "blocked" }) answers se_error (song 291 here), NOT the select sound' },
      { id: 'S9 every effect is an error', from: "const refused = Array.isArray(effects) && effects.some((e) => e && ERROR_EFFECTS.includes(e.type));", to: 'const refused = Array.isArray(effects) && effects.length > 0;', expect: 'menu: the same press without a refusal (no effects, a battle effect, a screen effect) plays the select sound; so does a press that only moves a cursor with no effects' },
      { id: 'S10 a refused battle choice buzzes', from: "try { menuSfx(action, sceneSig(scene) !== s0, MENU_MODES.includes(m0)); } catch (_e) { /* ignore */ }", to: "try { menuSfx(action, sceneSig(scene) !== s0, MENU_MODES.includes(m0), scene.mode === 'steps' ? [{ type: 'blocked' }] : undefined); } catch (_e) { /* ignore */ }", expect: 'menu: the battle screen\'s own refusals (a move with no PP, a fainted Pokemon, "already in battle") play the SELECT sound only, never the error buzz (the real game does exactly that: oracle-verified)' },
      { id: 'S13 the first animator sound switches the hit sound off', from: "chain('onHit', (_side, info) => { playKey(HIT_KEY(info && info.eff)); });", to: "chain('onHit', (_side, info) => { if (!S.animSounds) playKey(HIT_KEY(info && info.eff)); });", expect: 'hooks: the effectiveness sound (se_hit_super / weak / normal = 204 / 205 / 203 here) plays at every damaging hit, EVEN AFTER the animator has delivered sounds of its own (it never delivers this one: it is the battle script\'s)' },
      { id: 'S15 the prompt carries the old browser-rule clause', from: "long: 'Click, tap or press a keyboard key to start the sound (a controller button cannot). Esc or a controller button hides this.',", to: "long: 'Click, tap or press a keyboard key to start the sound. (A controller button cannot start it: that is a browser rule.)',", expect: 'prompt text: BOTH variants say what to do (click, tap or press a key) and that a controller button cannot (the layout decides which one is shown); neither carries the old "(that is a browser rule)" clause; the short one is short' },
      { id: 'S14 the animator\'s copy of the faint sound is not dropped', from: "if (nowMs() - t < FALLBACK_DEDUPE_MS) return; }", to: "if (false) return; }", expect: 'hooks: a faint plays se_faint ONCE: the animator\'s own copy of the same sound arriving right after is dropped; other animator sounds still pass' },
      { id: 'S16 a page restored from the cache stays silent', from: 'try { director.set(w.key, w.then); } catch (_e) { /* the music is optional */ }', to: '', expect: 'page cache: pagehide stops the song and a pageshow FROM the cache brings the wanted song back (the battle page: straight from the director); a pageshow that is not from the cache brings nothing' },
      { id: 'S17 a pageshow that is not from the cache restarts the music', from: 'if (S.destroyed || !e || e.persisted !== true) return;', to: 'if (S.destroyed || !e) return;', expect: 'page cache: pagehide stops the song and a pageshow FROM the cache brings the wanted song back (the battle page: straight from the director); a pageshow that is not from the cache brings nothing' },
      { id: 'S18 the wanted song is not remembered when the page goes away', from: 'if (w) S.wantAtHide = w; }', to: 'if (w) { /* mutant: not remembered */ } }', expect: 'page cache: a MENU page gets back the song of the player\'s pick (not the screen\'s own), and a page with the menu music Off stays silent' },
      { id: 'S19 the page cache listeners are never removed', from: "win.removeEventListener('pagehide', onPageHide); win.removeEventListener('pageshow', onPageShow); }", to: '}', expect: 'page cache: destroy() removes the pagehide and pageshow listeners' },
      { id: 'S20 Off leaves the engine unloaded', from: 'romFor, effects,', to: 'romFor,', expect: 'menu music Off: the engine still loads (the menus\' sound effects play) with the changer on Off BEFORE the sound can start, and no song is played' },
      { id: 'S21 the team editor loads the engine (and the Ultra Violet ROM) with Off: effects is true for every page', from: "(page === 'hub' || page === 'battle')", to: 'true', expect: 'menu music Off, effects are a page option: the hub and the battle page load the engine, the team editor loads nothing (Ultra Violet chosen: no ROM fetch either); the `effects` option overrides the default' },
      { id: 'S22 the effects option is ignored', from: 'const effects = opts.effects !== undefined ? opts.effects === true :', to: 'const effects = ', expect: 'menu music Off, effects are a page option: the hub and the battle page load the engine, the team editor loads nothing (Ultra Violet chosen: no ROM fetch either); the `effects` option overrides the default' },
      { id: 'S11 the opponent counts', from: "const p = st && st.player;", to: "const p = st && (st.foe || st.player);", expect: 'low-HP: only the PLAYER\'s Pokemon counts (the opponent in the red zone makes no beep)' },
    ];
    for (const m of SYSM) {
      let d; try { d = sysMut(m.id.split(' ')[0], m.from, m.to); } catch (e) { C.ok(false, 'mutant ' + m.id + ' could not be applied', e.message); continue; }
      let res; try { res = await sysBattery(d); } catch (e) { C.ok(false, 'mutant ' + m.id + ' broke the harness', e.message); continue; }
      const failed = res.filter((r) => !r.ok).map((r) => r.name);
      C.ok(failed.includes(m.expect), 'mutant ' + m.id + ' trips its named check', 'failed: ' + failed.join(' | ').slice(0, 500));
    }
  }
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
C.finish();
if (global.__skipped) console.log('NOTE: ' + global.__skipped + ' contract section(s) were SKIPPED because the module was absent.');
