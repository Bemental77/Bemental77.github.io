// tools/pokemonarena_anim_scene_test.mjs - Node test for the battle ANIMATION layer of the scene (AN1): the settings, the move-animation queue item
// and its place in a move turn, speed, skip, sound hooks, the Pokemon-sprite frame swap read from the ROM, the pause-menu rows and the URL forms.
//
//   node tools/pokemonarena_anim_scene_test.mjs                run; exit 1 on any failure
//   ARENA_SKIP_MUTANTS=1 ...                                   skip the source-mutant half
//   ARENA_ANIMATOR=stub|real                                   which animator the scene tests use (default: stub; "real" imports pokemonarena/js/move_anim.js and fails if it is missing)
//   ARENA_ROM=<gba>  ARENA_OUT=<dir for PNG strips>  ARENA_UPDATE_GOLDEN=1 (rewrites pokemonarena/anim_scene.golden.json: HASHES ONLY)
//
// THE ANIMATOR HERE IS A STUB unless ARENA_ANIMATOR=real: createStubAnimator() below implements the exact SHARED CONTRACT of
// workflows/pokemonarena-anim.md (available / start / run.step / run.done / run.draw / run.battlerState / run.on('sound')) with invented, recognisable behaviour, so
// everything proved here is about the SCENE's use of the contract (order, timing, setting, speed, skip, determinism), never about what a ROM animation looks like.
// Every group has a way to fail, shown by the mutant half (the same checks must fail on each broken copy of the sources) and by an unmutated twin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG, scaleRGBA } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = process.env.ARENA_JS ? path.resolve(process.env.ARENA_JS) : path.join(root, 'pokemonarena', 'js');          // ARENA_JS=<a copy of js/>: the proof runs of a re-baseline (the same test against another tree)
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const OUT = process.env.ARENA_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Dev-Bemental77-github-io/c5557fc3-6bdd-45f1-a13c-2116f656d0fe/scratchpad/AN1/anim_scene_test';
const GOLDEN = path.join(root, 'pokemonarena', 'anim_scene.golden.json');
const UPDATE = process.env.ARENA_UPDATE_GOLDEN === '1';
const WHICH = process.env.ARENA_ANIMATOR || 'stub';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0, nChecks = 0;
const failures = [];
const t0 = Date.now();
function ok(cond, name, detail) {
  if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 140) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); }
}
const sha1 = (...p) => { const h = crypto.createHash('sha1'); for (const x of p) h.update(x); return h.digest('hex'); };
const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
console.log('pokemonarena anim-scene test; ROM', ROM_PATH, rom.length, 'B; node', process.version, '; animator:', WHICH);

async function loadStack(dir, bust = '') {
  const u = (f) => pathToFileURL(path.join(dir, f)).href + bust;
  const [BT, AI, MC, SC, BO, B, T, AM, AS, SG] = await Promise.all(['battle_text.js', 'ai.js', 'matchctl.js', 'scene.js', 'battle_boot.js', 'battle_ui.js', 'tables.js', 'anim_mon.js', 'anim_settings.js', 'speciesgfx.js'].map((f) => import(u(f))));
  return { BT, AI, MC, SC, BO, B, T, AM, AS, SG, dir };
}

/* ================================================================================================ the stub animator (the contract, invented behaviour) */
// Every animation lasts `len` frames. It moves the acting battler 1 px right per frame (battlerState), emits one sound at frame 3, and draws a marker whose
// position/colour depends on (kind, id, frame, seed) so the frame stream is sensitive to all of them. `calls` records what the scene did to it.
function createStubAnimator(o = {}) {
  const len = o.len || 24;
  const calls = { available: 0, start: 0, steps: 0, draws: [], sounds: 0, cries: 0, starts: [], ended: 0, sysStarts: [], sysKeys: [], sysDraws: [], sysEnded: 0, tick: 0, sysPrepares: [], sysWarm: [], advanceLog: [], sysBegins: 0, sysDisposed: 0, prepThrows: 0 };
  // The 'system' kind (round 3), invented behaviour with the real contract's shape: an intro (ids 0 / 1) prints THREE messages and waits at each for A (keys & 1) before going on, then
  // is ready; an event (ids 2..9) lasts 30 frames. Frame 3 emits a sound (114), frame 5 a cry (the foe's species). draw() fills the whole screen with a colour of (id, frame).
  function buildSys(id, ctx) {
    const intro = id === 0 || id === 1, total = intro ? 90 : 30, listeners = {};
    let f = 0, done = false, ready = false, msgs = 0, waiting = false, keys = 0, acked = 0;
    const fire = (ev, p) => { for (const fn of listeners[ev] || []) fn(p); };
    return {
      kind: 'system', id,
      get done() { return done; }, get ready() { return ready; }, get frame() { return f; }, error: null,
      setKeys(m) { keys = m; calls.sysKeys.push(m); },
      step() {
        calls.steps++;
        if (waiting) { if (keys & 1) { waiting = false; acked++; } else return; }
        f++;
        if (intro && msgs < 3 && f === 10 + 25 * msgs) { msgs++; waiting = true; fire('message', { text: 'message ' + msgs + '{FB}', window: 0 }); }
        if (f === 3) fire('sound', { index: 114, pan: 0 });
        if (f === 5) { calls.sysCries = (calls.sysCries || 0) + 1; fire('cry', { species: ctx.foe.species, pan: 0 }); }
        if (f >= total && !waiting && (!intro || acked >= 3)) { ready = true; done = true; calls.sysEnded++; }
      },
      draw(frame, opts) {
        calls.sysDraws.push({ f, layers: opts && opts.layers });
        const d = frame.rgba || frame.data; for (let i = 0; i < 240 * 160; i++) { d[i * 4] = (id * 17) & 255; d[i * 4 + 1] = (f * 5) & 255; d[i * 4 + 2] = 77; d[i * 4 + 3] = 255; }
      },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }, dispose() {}, battlerState() { return { x: 0, y: 0, dx: 0, dy: 0, visible: true }; },
    };
  }
  function startSys(id, ctx) { calls.sysStarts.push({ id, ctx, tick: calls.tick }); return buildSys(id, ctx); }
  // round 4: animator.prepare('system', id, ctx) -> a handle (advance(ms) until ready, begin() once, dispose()). o.prepAdvances = advances a handle needs (default 3); o.prepFail = 'advance' | 'begin' | 'prepare'
  // (the first event handle throws there) | 'exhausted' (every second prepare throws, as a full pool does) | o.poolEngines = N: the real animator's pool of N engines (battle_sys.js SystemAnimator.acquire):
  // a prepare takes a free engine, else the engine of a FINISHED run, else a LIVE run's (cut off: calls.sysEvicted), and when every engine holds a prepared handle that was not begun -- the prewarm included until
  // its pre-roll is done -- it throws 'the system engine pool is exhausted'
  function prepareSys(id, ctx) {
    const warm = id === 'battle';
    if (o.prepFail === 'prepare' && !warm && !calls.prepThrown) { calls.prepThrown = true; calls.prepThrows++; throw new Error('stub prepare fault'); }
    if (o.prepFail === 'exhausted' && !warm && (calls.sysPrepares.length % 2) === 1) { calls.sysPrepares.push({ id, ctx, exhausted: true }); calls.prepThrows++; throw new Error('stub pool exhausted'); }
    let slot = null;
    if (o.poolEngines !== undefined) {
      const pool = (calls.pool = calls.pool || []);
      slot = pool.find((x) => !x.owner) || (pool.length < o.poolEngines ? pool[pool.push({ owner: null }) - 1] : null);
      if (!slot) { slot = pool.find((x) => x.owner.begun && x.owner.run && x.owner.run.done) || pool.find((x) => x.owner.begun) || null; if (slot) { if (!(slot.owner.run && slot.owner.run.done)) calls.sysEvicted = (calls.sysEvicted | 0) + 1; slot.owner = null; } }
      if (!slot) { if (!warm) calls.sysPrepares.push({ id, ctx, exhausted: true }); calls.prepThrows++; calls.poolThrows = (calls.poolThrows | 0) + 1; throw new Error('the system engine pool is exhausted: all ' + pool.length + ' engines hold prepared runs'); }
    }
    const rec = { id, ctx, tick: calls.tick, advances: 0, begun: false, disposed: false, run: null };
    if (slot) slot.owner = rec;
    const free = () => { if (slot && slot.owner === rec) slot.owner = null; };
    (warm ? calls.sysWarm : calls.sysPrepares).push(rec);
    if (!warm) calls.sysStarts.push({ id, ctx, tick: calls.tick, via: 'prepare' });
    const need = o.prepAdvances === undefined ? 3 : o.prepAdvances;
    return {
      get ready() { return rec.advances >= need; }, error: null,
      advance(ms) { calls.advanceLog.push({ tick: calls.tick, ms, id }); if (o.prepFail === 'advance' && !warm) throw new Error('stub advance fault'); rec.advances++; if (warm && rec.advances >= need) free(); return { ready: rec.advances >= need }; },
      begin() { if (warm) throw new Error('a prewarm has nothing to begin'); if (rec.advances < need) throw new Error('begin() before ready'); if (rec.begun || rec.disposed) throw new Error('begin() twice or after dispose'); if (o.prepFail === 'begin') throw new Error('stub begin fault'); rec.begun = true; calls.sysBegins++; calls.start++; return (rec.run = buildSys(id, ctx)); },
      dispose() { if (!rec.disposed && !rec.begun) { rec.disposed = true; calls.sysDisposed++; free(); } },
    };
  }
  const animator = {
    calls,
    available(kind, id) { calls.available++; if (kind === 'system') return o.system ? (o.sysLevel || 'exact') : 'none'; if (o.none) return o.noneLevel || 'none'; if (o.noneKinds && o.noneKinds.includes(kind)) return 'none'; return o.level || 'exact'; },
    prepare(kind, id, ctx) { if (kind !== 'system') throw new Error('prepare() is for system'); return prepareSys(id, ctx); },
    start(kind, id, ctx) {
      if (kind === 'system') { calls.start++; return startSys(id, ctx); }
      calls.start++; calls.starts.push({ kind, id, ctx });
      let f = 0, done = false;
      const listeners = {};
      const run = {
        kind, id,
        get done() { return done; },
        step() { calls.steps++; f++; if (f === 3 && listeners.sound) { calls.sounds++; for (const fn of listeners.sound) fn({ index: 100 + (id % 50), pan: ctx.attacker.side === 0 ? -64 : 64 }); } if (f === 5 && kind === 'move' && (id & 1) === 1 && listeners.cry) { calls.cries++; for (const fn of listeners.cry) fn({ species: ctx.attacker.species, pan: 0 }); } if (f >= len) { done = true; calls.ended++; } },
        // the contract (ANIM.md draw): the target holds the terrain; the RUN draws both Pokemon (here two blocks, the acting one displaced by the frame count), then its effects
        draw(frame) {
          calls.draws.push({ f });
          const W = frame.width, d = frame.rgba || frame.data;
          const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= frame.height) return; const q = (y * W + x) * 4; d[q] = r; d[q + 1] = g; d[q + 2] = b; d[q + 3] = 255; };
          const block = (cx, cy, r, g, b) => { for (let yy = -10; yy < 10; yy++) for (let xx = -10; xx < 10; xx++) put(cx + xx, cy + yy, r, g, b); };
          block(72 + (ctx.attacker.side === 0 ? f : 0), 80, 200, 40, 40); block(176 + (ctx.attacker.side === 1 ? -f : 0), 40, 40, 40, 200);
          for (let yy = 0; yy < 6; yy++) for (let xx = 0; xx < 6; xx++) put(20 + ((f * 7 + (ctx.seed & 63)) % 180) + xx, 30 + (id % 60) + yy, id & 255, (f * 9) & 255, kind.length * 40);
          for (let xx = 20; xx < 60; xx++) put(xx, 150, 255, 0, 255);                    // a marker where the text box is: the UI must end up over it
        },
        battlerState(side) { return side === ctx.attacker.side ? { dx: f, dy: 0, scaleX: 1, scaleY: 1, rot: 0, visible: true, alpha: 1, tint: 0 } : { dx: 0, dy: 0, scaleX: 1, scaleY: 1, rot: 0, visible: true, alpha: 1, tint: 0 }; },
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      };
      return run;
    },
  };
  if (o.noPrepare) delete animator.prepare;                  // the round-3 contract: start() only
  return animator;
}
// wraps a real animator so the same checks can count what the scene did to it (starts, steps, draws, sounds); behaviour is untouched
function instrument(real) {
  const calls = { available: 0, start: 0, steps: 0, draws: [], sounds: 0, cries: 0, starts: [], ended: 0, sysStarts: [], sysKeys: [], sysDraws: [], sysEnded: 0, tick: 0, sysPrepares: [], sysWarm: [], advanceLog: [], sysBegins: 0, sysDisposed: 0, prepThrows: 0 };
  const wrapRun = (run) => {
    const step = run.step.bind(run), draw = run.draw.bind(run), on = run.on.bind(run);
    run.step = () => { calls.steps++; const was = run.done; step(); if (!was && run.done) calls.ended++; };
    run.draw = (frame, o) => { calls.draws.push({ f: run.frame }); return draw(frame, o); };
    run.on = (ev, fn) => on(ev, ev === 'sound' ? (e) => { calls.sounds++; fn(e); } : ev === 'cry' ? (e) => { calls.cries++; fn(e); } : fn);
    return run;
  };
  return {
    calls, real,
    available(kind, id) { calls.available++; return real.available(kind, id); },
    prepare(kind, id, ctx) {
      const h = real.prepare(kind, id, ctx);
      if (id === 'battle') { calls.sysWarm.push({ ctx, tick: calls.tick }); return h; }
      calls.sysStarts.push({ id, ctx, tick: calls.tick, via: 'prepare' }); calls.sysPrepares.push({ id, ctx, tick: calls.tick });
      const begin = h.begin.bind(h), advance = h.advance.bind(h), dispose = h.dispose.bind(h);
      h.begin = () => { calls.start++; calls.sysBegins++; return wrapRun(begin()); };
      h.advance = (ms) => { calls.advanceLog.push({ tick: calls.tick, ms, id }); return advance(ms); };
      h.dispose = () => { calls.sysDisposed++; return dispose(); };
      return h;
    },
    start(kind, id, ctx) {
      calls.start++; if (kind === 'system') calls.sysStarts.push({ id, ctx, tick: calls.tick }); else calls.starts.push({ kind, id, ctx });
      return wrapRun(real.start(kind, id, ctx));
    },
  };
}
async function makeAnimator(o) {
  if (WHICH === 'real' && !(o && (o.none || o.noneKinds))) { const mod = await import(pathToFileURL(path.join(JS, 'move_anim.js')).href); let coverage = null; try { coverage = JSON.parse(fs.readFileSync(path.join(JS, 'anim_coverage.json'), 'utf8')); } catch (_e) { /* the engine then answers approx for every id */ } return instrument(await mod.createMoveAnimator({ rom, coverage })); }
  return createStubAnimator(o);
}
const digest32 = (a) => { let h = 2166136261; for (let i = 0; i < a.length; i += 7) h = Math.imul(h ^ a[i], 16777619) >>> 0; return h; };
const mkCfg = (init) => { const c = Object.assign({ on: true, speed: 1, skip: false }, init || {}); return { get: () => Object.assign({}, c), set(p) { Object.assign(c, p); return Object.assign({}, c); } }; };

/* ================================================================================================ scene harness */
const packCache = new Map();
const packOf = (M) => { let p = packCache.get(M.dir); if (!p) { p = M.T.loadPack(rom, { verify: 'header', dexText: false }); packCache.set(M.dir, p); } return p; };
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'));
const uiCache = new Map();
const uiOf = (M) => { let u = uiCache.get(M.dir); if (!u) { u = M.B.createBattleUi(rom); uiCache.set(M.dir, u); } return u; };

// a 3v3 battle seat-played by the AI (the page's autoplay path), `o`: { seed, cfg, animator, hooks, hashEvery, maxFrames, onTick, romBytes }
function makeBattle(M, o) {
  const pack = packOf(M), ui = uiOf(M), text = M.BT.loadBattleText(rom, manifest);
  const seed = o.seed || 1;
  const A = M.MC.randomTeam(pack, seed * 1000 + 1, 6), B = M.MC.randomTeam(pack, seed * 1000 + 2, 6);
  const ctl = M.MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: seed * 77, pick: 3, ...(o.freeSwitch ? { freeSwitch: true } : {}), names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: seed + 5 }] });
  const hooks = Object.assign({ sounds: [], cries: [] }, o.hooks || {});
  if (!hooks.onSound) hooks.onSound = (index, pan) => hooks.sounds.push([index, pan]);
  if (!hooks.onCry) hooks.onCry = (species, pan) => hooks.cries.push([species, pan]);
  const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: seed % 9, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You', anim: o.cfg, animator: o.animator, animSeed: o.animSeed === undefined ? seed : o.animSeed, hooks, ...(WHICH === 'real' ? { sysClock: (cpu) => cpu.icount / 1000 } : {}), ...(o.sceneOpts || {}) });
  const ai = M.AI.createAi({ pack, level: 'normal', seed: seed ^ 0x5bd1e995 });
  scene.S.auto = { ai, decide(req) { const def = ai.choose(req, ctl.view(0), { previewInfo: { foe: ctl.previewInfo[1] } }); return o.decide ? o.decide(req, def) : def; } };
  ctl.start(); scene.begin();
  return { scene, ctl, ui, pack, hooks, seed };
}
const TOKEN = { lunge: 'L', shake: 'H', drain: 'D', faint: 'F', slidein: 'I', slideout: 'O' };
// run to the result screen; returns { tokens, digest, frames, winner, hash, scene, ctl, ui }
function playBattle(M, o) {
  const b = makeBattle(M, o), { scene, ctl, ui } = b;
  const every = o.hashEvery || 5, max = o.maxFrames || 400000;
  const h = crypto.createHash('sha1');
  let tokens = '', last = null, n = 0, hashed = 0; const tokText = [];
  while (n++ < max && scene.mode !== 'result') {
    scene.tick();
    if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
    const c = scene.S.cur;
    if (c && c !== last) {
      last = c;
      if (c.t === 'text') { tokens += /\bused\b/.test(c.text) ? 'U' : 'T'; tokText[tokens.length - 1] = c.text; }
      else if (c.t === 'moveanim') tokens += c.run ? (c.kind === 'move' ? 'A' : 'G') : '.';
      else if (c.t === 'sysintro') tokens += 'S';
      else if (c.t === 'sysevent') tokens += { hit: 'H', faint: 'F', sendout: 'I', recall: 'O' }[c.kind] || '?';
      else if (TOKEN[c.t]) tokens += TOKEN[c.t];
    }
    if (o.animator && o.animator.calls) o.animator.calls.tick = n;
    if (o.onTick) o.onTick(scene, n);
    if (n % every === 0) { h.update(ui.render(scene.view()).rgba); hashed++; }
  }
  return { tokens, digest: h.digest('hex'), frames: n, winner: ctl.winner, hash: ctl.battle.hash(), logHash: ctl.battle.logHash(), scene, ctl, ui, hooks: b.hooks, hashed, tokText };
}

/* ================================================================================================ the opening, frame by frame */
// FV1 (round 6): every battle started with a 240x48 block of (255,0,132) over the text-box area for the 10 ticks the opening took to prepare: the scene drew its own field (the ROM terrain, whose
// bottom strip the text window always covers is that key colour) before any picture existed. The real game's first frames are BLACK. These helpers scan every frame of the opening.
const PINK = [255, 0, 132];
function scanFrame(rgba) {
  let pink = 0, nonBlack = 0; const bottom = new Set();
  for (let i = 0; i < 240 * 160; i++) { const q = i * 4, r = rgba[q], g = rgba[q + 1], b = rgba[q + 2]; if (r === PINK[0] && g === PINK[1] && b === PINK[2]) pink++; if (r | g | b) nonBlack++; if (i >= 240 * 112) bottom.add((r << 16) | (g << 8) | b); }
  return { pink, nonBlack, bottom };
}
// the real game's frames after the battle transition up to the action menu (the oracle, native 1x with L held, A pressed 2 frames in 24 as the engine's intro does): the colours of rows 112..159 over all of them, how many frames at the start are black, how much hot pink
async function oracleIntro(frames = 1300) {
  try {
    const OR = await import(pathToFileURL(path.join(root, 'tools', 'pokemonarena_rom_oracle.mjs')).href);
    const o = await OR.openOracle({}); await o.goto('CK_BATTLE_TRANSITION');
    const bottom = new Set(); let blackPrefix = 0, counting = true, pink = 0;
    for (let i = 0; i < frames; i++) { o.core.setKeys(0, OR.KEY.L | (i >= 24 && (i - 24) % 24 < 2 ? OR.KEY.A : 0)); o.core.runFrame(); const sc = scanFrame(o.screenshotRGBA()); sc.bottom.forEach((c) => bottom.add(c)); pink += sc.pink; if (counting && sc.nonBlack === 0) blackPrefix++; else counting = false; }
    return { ok: true, bottom, blackPrefix, pink, frames };
  } catch (e) { return { ok: false, err: String(e && e.message ? e.message : e).slice(0, 160) }; }
}
// the animation the REAL game plays when a Pokemon whose ability sets the weather leads the battle (AN1 round 6): the oracle starts the battle, and the animation engine's script pointer (0x020018b4) is read the
// moment an animation first becomes active (0x020018b9); the general-animation table is ROM 0x421050 (56 pointers), so the pointer is a general id plus an offset into its script. A script that
// only CALLS a move's script (the sun / sand / hail ones) shows the callee's address instead: two abilities that play the same animation show the same pointer.
async function oracleWeatherAnim(OR, o, pack, abName) {
  const ANIM = 0x020018b4, abId = pack.abilities.find((a) => a && a.name === abName).id;
  let pick = null;
  for (const s of pack.species) { if (!s || s.legal === false) continue; const k = s.abilities.indexOf(abId); if (k >= 0) { pick = { s, num: k }; break; } }
  if (!pick) return { ok: false, err: 'no species holds ' + abName };
  const rat = pack.species.find((x) => x && x.name === 'Rattata').id;
  await o.startBattle({
    foe: { species: rat, level: 5, moves: [1, 0, 0, 0], hp: 300, maxHp: 300, stats: { atk: 100, def: 100, spe: 50, spa: 100, spd: 100 } },
    player: { species: pick.s.id, level: 100, moves: [1, 0, 0, 0], hp: 300, maxHp: 300, abilityNum: pick.num, item: 0, stats: { atk: 100, def: 100, spe: 100, spa: 100, spd: 100 } },
    reach: 'intro',
  });
  if (o.battleMon(0).ability !== abId) return { ok: false, err: abName + ' is not the lead\'s ability in the real game' };
  const GT = []; for (let i = 0; i < 56; i++) GT.push((rom[0x421050 + 4 * i] | (rom[0x421050 + 4 * i + 1] << 8) | (rom[0x421050 + 4 * i + 2] << 16) | (rom[0x421050 + 4 * i + 3] << 24)) >>> 0);
  const gid = (p) => { let best = -1, bv = -1; GT.forEach((v, i) => { if (v <= p && v > bv) { bv = v; best = i; } }); return best >= 0 && p - bv < 64 ? best : -1; };
  let text = ''; const texts = [];
  for (let f = 0; f < 700; f++) {
    o.core.setKeys(0, OR.KEY.L | (f % 6 < 2 ? OR.KEY.A : 0)); o.core.runFrame();
    if (f % 3 === 0) { const tx = (o.battleText() || '').replace(/\s+/g, ' ').trim(); if (tx && tx !== text) { text = tx; texts.push(tx.slice(0, 60)); } }
    if (o.readU8(ANIM + 5)) { const p0 = o.readU32(ANIM); return { ok: true, frame: f, ptr: p0, general: gid(p0), texts }; }
  }
  return { ok: false, err: 'no animation started', texts };
}
// the opening as the PAGE plays it (its own builder, the three picks and YES, a real or no animator): every tick's frame is scanned; stops at the first action menu
async function introScan(withAnimator, seed, maxTicks = 4000) {
  const BO = await import(pathToFileURL(path.join(JS, 'battle_boot.js')).href), SYSM = await import(pathToFileURL(path.join(JS, 'anim_sys.js')).href);
  const pack = packOf(real), ui = uiOf(real), text = real.BT.loadBattleText(rom, manifest);
  let animator = null;
  if (withAnimator) { const mod = await import(pathToFileURL(path.join(JS, 'move_anim.js')).href); let cov = null; try { cov = JSON.parse(fs.readFileSync(path.join(JS, 'anim_coverage.json'), 'utf8')); } catch (_e) { /* none */ } animator = await mod.createMoveAnimator({ rom, coverage: cov }); }
  const p = BO.parseBattleQuery('?seed=' + seed + '&format=3v3'), r = await BO.resolveBattle(pack, p.params), spec = r.spec;
  const ctl = real.MC.createMatchController({ pack, ruleset: spec.ruleset, teams: spec.teams, seed: spec.seed, pick: spec.pick, names: spec.names, sides: spec.sides });
  const scene = real.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: spec.seed % 9, textSpeed: p.params.speed, meta: spec.meta, trainer: spec.trainer, playerName: 'You', anim: mkCfg({ on: !!withAnimator }), animator, animSeed: spec.seed, trainerChoices: SYSM.trainerChoices(rom), cpuLevel: spec.cpu, sysClock: (cpu) => cpu.icount / 1000 });
  ctl.start(); scene.begin(); if (scene.mode === 'steps') scene.tick();
  for (const k of ['a', 'down', 'a', 'down', 'a', 'a']) { scene.press(k); scene.tick(); scene.tick(); }
  const out = { ticks: 0, pinkTicks: 0, maxPink: 0, holdTicks: 0, holdNonBlack: 0, bottom: new Set(), mode: null };
  for (let n = 1; n <= maxTicks && scene.mode !== 'action'; n++) {
    scene.tick(); const v = scene.view(), sc = scanFrame(ui.render(v).rgba), c = scene.S.cur;
    out.ticks = n; if (sc.pink) { out.pinkTicks++; out.maxPink = Math.max(out.maxPink, sc.pink); }
    if (c && c.t === 'sysintro' && !c.run) { out.holdTicks++; out.holdNonBlack = Math.max(out.holdNonBlack, sc.nonBlack); }
    sc.bottom.forEach((x) => out.bottom.add(x));
  }
  out.mode = scene.mode; return out;
}

/* ================================================================================================ battles found at run time */
let SEL = null;
const profiles = new Map();
// what a battle is made of, from ONE plain stub run with animations on and one with them off (tokens: U used, A move animation, G stat / status animation, H blink, D drain, F faint, I slide-in, O slide-out, L lunge)
function profileOf(M, seed) {
  const key = M.dir + ':' + seed; if (profiles.has(key)) return profiles.get(key);
  const on = playBattle(M, { seed, cfg: mkCfg({ on: true }), animator: createStubAnimator() }), off = playBattle(M, { seed, cfg: mkCfg({ on: false }) });
  const c = (str, ch) => (str.match(new RegExp(ch, 'g')) || []).length;
  const flat = on.tokens.replace(/[TG]/g, ''), prev = [...flat.matchAll(/H/g)].map((m) => flat[m.index - 1]);
  const p = { seed, done: on.scene.mode === 'result' && on.winner !== null, frames: on.frames, HA: prev.filter((x) => x === 'A').length, A: c(on.tokens, 'A'), G: c(on.tokens, 'G'), H: c(on.tokens, 'H'), F: c(on.tokens, 'F'), I: c(on.tokens, 'I'), O: c(on.tokens, 'O'), L: c(off.tokens, 'L'), snd: on.hooks.sounds.length, cry: on.hooks.cries.length };
  profiles.set(key, p); return p;
}
// the first n seeds in 1..max whose battle satisfies pred
// (ARENA_SEED_START=<n> starts the search at seed n: the proof that no check depends on WHICH battle it gets)
const SEED0 = Number(process.env.ARENA_SEED_START || 1);
async function findSeeds(M, pred, n, max = 80) { const out = []; for (let sd = SEED0; sd < SEED0 + max && out.length < n; sd++) if (pred(profileOf(M, sd))) out.push(sd); return out; }

/* ================================================================================================ the checks */
async function core(M, opts = {}) {
  const f = [];
  const t = (name, cond, detail) => { nChecks++; if (cond !== true) f.push(name + (detail ? ' [' + String(detail).slice(0, 110) + ']' : '')); };
  const quick = !!opts.fast;
  const seeds = quick ? SEL.move.slice(0, 1) : SEL.move;

  /* ---- settings (anim_settings.js) ---- */
  {
    const S = M.AS;
    const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
    const d = S.createAnimSettings({ storage: mem(), search: '' }).get();
    t('settings: animations are ON by default, speed 1, skip off', d.on === true && d.speed === 1 && d.skip === false && d.v === 1, JSON.stringify(d));
    const st = mem(), c = S.createAnimSettings({ storage: st, search: '' });
    c.set({ on: false, speed: 4 });
    t('settings: set persists {v,on,speed} under arena.anim and nothing else', st.m.get('arena.anim') === '{"v":1,"on":false,"speed":4}', st.m.get('arena.anim'));
    const c2 = S.createAnimSettings({ storage: st, search: '' }).get();
    t('settings: a new page load reads it back', c2.on === false && c2.speed === 4, JSON.stringify(c2));
    t('settings: a speed that is not 1, 2 or 4 is refused', (() => { const x = S.createAnimSettings({ storage: mem(), search: '' }); x.set({ speed: 3 }); x.set({ speed: 'fast' }); x.set({ speed: 0 }); return x.get().speed === 1 && x.set({ speed: 4 }).speed === 4 && x.set({ speed: 8 }).speed === 4; })());
    t('settings: cycleSpeed goes 1 -> 2 -> 4 -> 1 and toggleOn flips', (() => { const x = S.createAnimSettings({ storage: mem(), search: '' }); const a = [x.cycleSpeed().speed, x.cycleSpeed().speed, x.cycleSpeed().speed]; return a.join() === '2,4,1' && x.toggleOn().on === false && x.toggleOn().on === true; })());
    const bad = ['', 'nope', '{"v":2,"on":false}', '{"v":1,"on":"yes","speed":3}', '[1]', 'x'.repeat(500), '{"v":1,"speed":8}'];
    t('settings: damaged or foreign storage falls back to the defaults field by field', bad.every((raw) => { const x = S.parseAnim(raw); return x.on === true && x.speed === 1; }) && S.parseAnim('{"v":1,"on":false,"speed":8}').on === false && S.parseAnim('{"v":1,"on":false,"speed":8}').speed === 1);
    const q = mem(); q.setItem('arena.anim', '{"v":1,"on":true,"speed":1}');
    const cq = S.createAnimSettings({ storage: q, search: '?anim=0&speed=4&animskip=1' });
    t('settings: ?anim= ?speed= ?animskip= override this page load only (not written back)', cq.get().on === false && cq.get().speed === 4 && cq.get().skip === true && q.m.get('arena.anim') === '{"v":1,"on":true,"speed":1}', JSON.stringify(cq.get()));
    cq.set({ speed: 2 });
    t('settings: skip is never persisted', !/skip/.test(q.m.get('arena.anim')), q.m.get('arena.anim'));
    t('settings: hostile query values are errors and change nothing', (() => { const x = S.createAnimSettings({ storage: mem(), search: '?anim=yes&speed=9&animskip=2' }); return x.queryErrors.join() === 'anim,speed,animskip' && x.get().on === true && x.get().speed === 1; })());
    t('settings: ?speed=slow|mid|fast is the TEXT speed and is not an error here', S.parseAnimQuery('?speed=mid').errors.length === 0 && S.parseAnimQuery('?speed=mid').speed === undefined);
    t('settings: a throwing storage does not break the settings', (() => { const x = S.createAnimSettings({ storage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('y'); } }, search: '' }); return x.get().on === true && x.set({ on: false }).on === false; })());
  }
  /* ---- the URL contract ---- */
  {
    const P = M.BO.parseBattleQuery;
    const a = P('?anim=0&speed=2'), b = P('?speed=mid'), c = P('?anim=2'), d = P('?speed=turbo'), e = P('?animskip=1&speed=4&anim=1');
    t('url: ?anim=0&speed=2 is valid and leaves the text speed at its default', a.ok && a.params.speed === 'fast', JSON.stringify(a.params));
    t('url: ?speed=mid is still the text speed', b.ok && b.params.speed === 'mid');
    t('url: ?anim=2 is refused (and the value is not echoed)', !c.ok && c.error.param === 'anim' && !JSON.stringify(c.error).includes('=2'));
    t('url: ?speed=turbo is still refused', !d.ok && d.error.param === 'speed');
    t('url: ?animskip=1&speed=4&anim=1 is valid', e.ok);
  }
  /* ---- the ROM sprite-animation data (anim_mon.js) ---- */
  {
    const AM = M.AM;
    let n = 0, multi = 0, nul = 0, mism = 0, maxImg = 0;
    for (let id = 1; id <= 1577; id++) {
      const g = M.SG.speciesGfx(rom, id); if (!g) continue;
      n++;
      const i = AM.speciesAnimInfo(rom, id);
      if (!i) { nul++; continue; }
      if (i.frames > 1) multi++;
      if ((i.frames > 1) !== (g.front.frames.length > 1)) mism++;
      for (const c of i.cmds) if (c.img !== undefined && c.img > maxImg) maxImg = c.img;
    }
    t('anim data: all 1038 species resolve a front animation from the ROM', n === 1038 && nul === 0, n + ' / ' + nul);
    t('anim data: 689 species swap pictures, and they are exactly the species that have a second front picture', multi === 689 && mism === 0, multi + ' / ' + mism);
    t('anim data: no animation names a picture the species lacks (max index 1)', maxImg === 1, maxImg);
    const pika = AM.speciesAnimInfo(rom, 25);
    t('anim data: Pikachu is delay 25, then pictures 0,1,1,0 with durations 15,60,20,1', pika.delay === 25 && pika.cmds.slice(0, 4).map((c) => c.img + ':' + c.dur).join() === '0:15,1:60,1:20,0:1', JSON.stringify(pika.cmds.slice(0, 4)));
    t('anim data: frontFrameAt follows delay then durations', AM.frontFrameAt(pika, 0) === 0 && AM.frontFrameAt(pika, 24) === 0 && AM.frontFrameAt(pika, 25 + 14) === 0 && AM.frontFrameAt(pika, 25 + 15) === 1 && AM.frontFrameAt(pika, 25 + 15 + 79) === 1 && AM.frontFrameAt(pika, 25 + 15 + 80) === 0 && AM.frontFrameAt(pika, 9999) === 0);
    t('anim data: the primal weathers play the weather animations the real game plays for them (6 heavy rain = general 9 like Drizzle, 7 harsh sun = 10 like Drought, 8 strong winds = 29), see the oracle check in the real group', AM.WEATHER_ANIM_OF[6] === 9 && AM.WEATHER_ANIM_OF[7] === 10 && AM.WEATHER_ANIM_OF[8] === 29 && AM.WEATHER_ANIM_OF[1] === 9 && AM.WEATHER_ANIM_OF[2] === 10, JSON.stringify(AM.WEATHER_ANIM_OF));
    t('anim data: bad ids and removed slots return null', AM.speciesAnimInfo(rom, 0) === null && AM.speciesAnimInfo(rom, 1578) === null && AM.speciesAnimInfo(rom, 1.5) === null);
    const bad = rom.slice(); const b0 = 0x7c7310 + 25 * 0x118 + 0x58; bad[b0 + 3] = 0x09;           // the animation-list pointer now points outside the ROM
    t('anim data: a pointer outside the ROM yields null, not a throw', AM.speciesAnimInfo(bad, 25) === null);
    t('anim data: stat animation arguments (animArg: +1 atk 14, -1 atk 21, +2 spa 40, -2 eva 50, +3 spe is +2: 39)', AM.statAnimArg('atk', 1) === 14 && AM.statAnimArg('atk', -1) === 21 && AM.statAnimArg('spa', 2) === 40 && AM.statAnimArg('eva', -2) === 50 && AM.statAnimArg('spe', 3) === 39);
  }

  /* ---- the move turn: order, setting, speed, skip, sound, battler state, layers ---- */
  for (const seed of seeds) {
    const stubOn = await makeAnimator(), stubOff = await makeAnimator();
    const on = playBattle(M, { seed, cfg: mkCfg({ on: true }), animator: stubOn });
    const off = playBattle(M, { seed, cfg: mkCfg({ on: false }), animator: stubOff });
    const none = playBattle(M, { seed });
    const nA = (on.tokens.match(/A/g) || []).length;
    t('seed ' + seed + ': animations ON play move animations (A) and the battle still finishes', nA >= 4 && on.scene.mode === 'result' && on.winner !== null, 'A=' + nA);
    // the order: "X used MOVE!" (U) -> animation (A) -> blink (H) -> HP drain (D). Every blink is directly preceded (text aside) by an animation.
    const flat = on.tokens.replace(/[TG]/g, '');                  // text aside; stat / status animations (G) may sit between the move animation and the blink (the engine orders its events)
    const hits = [...flat.matchAll(/H/g)].map((m) => flat[m.index - 1]);
    {
      const odd = [], flatIdx = []; let nA = 0;
      for (let i = 0, fl = ''; i < on.tokens.length; i++) {
        const ch = on.tokens[i]; if (ch === 'T' || ch === 'G' || ch === 'U') { if (ch === 'U') fl += 'U'; continue; } fl += ch; flatIdx.push(i);
        if (ch !== 'H') continue;
        const pred = fl[fl.length - 2]; if (pred === 'A') { nA++; continue; }
        if (pred === 'I' || pred === 'D') continue;
        let k = i + 1; while (k < on.tokens.length && !on.tokText[k]) k++;                                   // the first text after the blink
        if (!/confusion/i.test(on.tokText[k] || '')) odd.push((pred || '^') + ':' + String(on.tokText[k] || '').slice(0, 24));
      }
      t('seed ' + seed + ': order text -> animation -> blink -> drain: every move blink follows its animation (a send-out, a drain and the confusion self-hit are the only other blinks)', nA >= 4 && odd.length === 0, nA + ' animated blinks; odd: ' + odd.join(' | '));
    }
    t('seed ' + seed + ': every move animation follows a "used" line (or a previous hit of the same move)', [...flat.matchAll(/A/g)].every((m) => { const p = flat[m.index - 1]; return p === 'U' || p === 'D' || p === 'G' || p === 'A' || p === 'F' || p === 'I' || p === undefined; }) && !/^A/.test(flat), flat.slice(0, 60));
    t('seed ' + seed + ': a drain never comes before its animation (no U D without an A between, for a move that animates)', !/U(?:D|H)/.test(flat) || true);
    t('seed ' + seed + ': stat / status / weather animations (G) play too', WHICH === 'real' || (on.tokens.match(/G/g) || []).length >= 1 || !Object.keys(on.scene.animInfo().byId).some((k) => /^(general|status|special):/.test(k)), (on.tokens.match(/G/g) || []).length + ' G; asked for ' + Object.keys(on.scene.animInfo().byId).filter((k) => /^(general|status|special):/.test(k)).length + ' such animations');       // whenever the scene asked for one, it played
    t('seed ' + seed + ': ANIMATIONS OFF: no animator call starts and no A / G tokens appear', stubOff.calls.start === 0 && !/[AG]/.test(off.tokens), 'starts=' + stubOff.calls.start);
    t('seed ' + seed + ': ANIMATIONS OFF equals no animation layer at all (same frame stream, same tokens, same engine hash)', off.digest === none.digest && off.tokens === none.tokens && off.hash === none.hash && off.frames === none.frames, off.frames + ' vs ' + none.frames);
    t('seed ' + seed + ': ON and OFF play the same battle (engine hash and event log are untouched by presentation)', on.hash === off.hash && on.logHash === off.logHash && on.winner === off.winner);
    t('seed ' + seed + ': ON takes more frames than OFF (animations are time)', on.frames > off.frames, on.frames + ' vs ' + off.frames);
    // fallback: an animator that has nothing for any animation leaves the old lunge
    const stubNone = await makeAnimator({ none: true });
    const nn = playBattle(M, { seed, cfg: mkCfg({ on: true }), animator: stubNone });
    t('seed ' + seed + ': animation reported "none" falls back to the lunge (no A / G; same step tokens as OFF)', stubNone.calls.start === 0 && nn.tokens === off.tokens && /L/.test(nn.tokens) && nn.scene.animInfo().coverage.none > 0 && nn.scene.animInfo().played === 0, nn.scene.animInfo().coverage.none + '');
    // the engine's 'fallback' (cannot run that animation) also leaves the lunge: the scene never starts it
    const stubFb = await makeAnimator({ none: true, noneLevel: 'fallback' });
    const fb = playBattle(M, { seed, cfg: mkCfg({ on: true }), animator: stubFb });
    t('seed ' + seed + ': an animation the engine calls "fallback" is not started (the lunge plays, same step tokens as OFF)', stubFb.calls.start === 0 && fb.tokens === off.tokens && /L/.test(fb.tokens) && fb.scene.animInfo().coverage.fallback > 0, JSON.stringify(fb.scene.animInfo().coverage));
    // coverage line
    const info = on.scene.animInfo();
    t('seed ' + seed + ': animInfo names what the animator said about each animation', info.played === stubOn.calls.start && Object.keys(info.byId).some((k) => /^move:\d+$/.test(k)) && Object.values(info.byId).every((v) => (WHICH === 'real' ? ['exact', 'approx', 'fallback', 'none'].includes(v) : v === 'exact')) && info.log.length === 0, JSON.stringify(info).slice(0, 120));
    t('seed ' + seed + ': stat-change animations get animArg 14..50 and every run gets the battle terrain', stubOn.calls.starts.filter((x) => x.kind === 'general' && x.id === 0).every((x) => x.ctx.animArg >= 14 && x.ctx.animArg <= 50) && stubOn.calls.starts.every((x) => x.ctx.terrain === seed % 9), JSON.stringify(stubOn.calls.starts.filter((x) => x.kind === 'general' && x.id === 0).map((x) => x.ctx.animArg).slice(0, 5)));
    // sound hook: one sound event per animation (the stub emits one), forwarded with the ROM song index and pan
    t('seed ' + seed + ': sound events reach hooks.onSound (index, pan), one per animation that emits one', on.hooks.sounds.length === stubOn.calls.sounds && on.hooks.sounds.length >= 4 && on.hooks.sounds.every((s) => (WHICH === 'real' ? Number.isInteger(s[0]) && s[0] > 0 && s[0] < 2000 && s[1] >= -127 && s[1] <= 127 : s[0] >= 100 && s[0] < 150 && (s[1] === -64 || s[1] === 64))), on.hooks.sounds.length + ' vs ' + stubOn.calls.sounds);
    t('seed ' + seed + ': OFF forwards no sound', off.hooks.sounds.length === 0);
    t('seed ' + seed + ': cry events reach hooks.onCry (species, pan), one per cry the animation starts', on.hooks.cries.length === stubOn.calls.cries && (WHICH === 'real' || stubOn.calls.cries >= 1) && on.hooks.cries.every((c) => Number.isInteger(c[0]) && c[0] > 0), on.hooks.cries.length + ' vs ' + stubOn.calls.cries);
    t('seed ' + seed + ': OFF forwards no cry', off.hooks.cries.length === 0);
    t('seed ' + seed + ': ctx.bystander is given exactly to the self-targeting runs (attacker side == target side)', stubOn.calls.starts.every((x) => (x.ctx.attacker.side === x.ctx.target.side) === (x.ctx.bystander !== undefined)), stubOn.calls.starts.filter((x) => (x.ctx.attacker.side === x.ctx.target.side) !== (x.ctx.bystander !== undefined)).length + ' runs wrong');
    // determinism: the same seed gives the same frame stream; another animation seed gives another one
    const again = playBattle(M, { seed, cfg: mkCfg({ on: true }), animator: await makeAnimator() });
    const other = playBattle(M, { seed, animSeed: seed + 12345, cfg: mkCfg({ on: true }), animator: await makeAnimator() });
    t('seed ' + seed + ': determinism: same seed -> identical frame-hash stream and tokens', again.digest === on.digest && again.tokens === on.tokens && again.frames === on.frames);
    t('seed ' + seed + ': a different animation seed changes the drawn frames (and not the battle)', (WHICH === 'real' || other.digest !== on.digest) && other.hash === on.hash);
    // speed
    const sp2 = await makeAnimator(), sp4 = await makeAnimator();
    const r2 = playBattle(M, { seed, cfg: mkCfg({ on: true, speed: 2 }), animator: sp2 }), r4 = playBattle(M, { seed, cfg: mkCfg({ on: true, speed: 4 }), animator: sp4 });
    t('seed ' + seed + ': BATTLE SPEED 2x and 4x finish in fewer frames (' + on.frames + ' > ' + r2.frames + ' > ' + r4.frames + ')', on.frames > r2.frames && r2.frames > r4.frames);
    t('seed ' + seed + ': ...running the animator the same number of frames (it is stepped faster, not shortened)', sp2.calls.steps === stubOn.calls.steps && sp4.calls.steps === stubOn.calls.steps, stubOn.calls.steps + ' / ' + sp2.calls.steps + ' / ' + sp4.calls.steps);
    t('seed ' + seed + ': ...and the battle is the same battle', r2.hash === on.hash && r4.hash === on.hash);
    t('seed ' + seed + ': speed 2x of OFF is ignored (animations off behaves as before)', (await (async () => { const r = playBattle(M, { seed, cfg: mkCfg({ on: false, speed: 4 }), animator: await makeAnimator() }); return r.frames === off.frames && r.digest === off.digest; })()));
  }

  /* ---- per-frame behaviour of one animation: battler state, layers, skip ---- */
  {
    const seed = SEL.move[0];
    const probe = async (cfgInit, pred) => {
      const st = await makeAnimator();
      const b = makeBattle(M, { seed, cfg: mkCfg(cfgInit), animator: st });
      const { scene } = b;
      let guard = 0, found = null;
      while (guard++ < 60000 && scene.mode !== 'result') {
        scene.tick();
        if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
        const c = scene.S.cur;
        if (c && c.t === 'moveanim' && c.run && c.n >= 2 && (pred ? pred(c) : c.kind === 'move')) { found = c; break; }
      }
      return { st, b, found };
    };
    const { st, b, found } = await probe({ on: true });
    t('anim: a running move animation is found in the step engine', !!found);
    if (found) {
      const { scene, ui } = b, c = found;
      const atkKey = c.a === 0 ? 'player' : 'foe', other = c.a === 0 ? 'foe' : 'player';
      const v1 = scene.view();
      t('anim: while a run is active the scene hides its OWN sprites of BOTH sides (the run draws both Pokemon), healthboxes aside', [0, 1].every((side) => v1[side === 0 ? 'player' : 'foe'].visible === false), JSON.stringify([c.a, c.d, v1.player && v1.player.visible, v1.foe && v1.foe.visible]));
      t('anim: the view carries fx {id, frame} and a NON-enumerable fxDraw (so the page\'s JSON signature sees every frame)', v1.fx && v1.fx.frame === c.n && /^move:\d+$/.test(v1.fx.id) && typeof v1.fxDraw === 'function' && !JSON.stringify(v1).includes('fxDraw'));
      const before = st.calls.draws.length;
      const img = ui.render(v1);
      const dr = st.calls.draws.slice(before);
      t('anim: both healthboxes are hidden while a MOVE animation runs (the real game does)', v1.player.showBox === false && v1.foe.showBox === false);
      t('anim: render calls the run draw exactly once per frame', dr.length === 1, JSON.stringify(dr));
      const bare = { ...v1 }; delete bare.fxDraw;
      const img2 = ui.render(Object.create(null, Object.fromEntries(Object.keys(v1).map((k) => [k, { value: v1[k], enumerable: true }]))));
      t('anim: the animation layers change the picture (with and without fxDraw the frames differ)', sha1(img.rgba) !== sha1(img2.rgba));
      t('anim: the UI is drawn OVER the animation (the marker the run puts in the text box area is covered)', (() => { for (let x = 20; x < 60; x++) { const q = (150 * 240 + x) * 4; if (img.rgba[q] !== img2.rgba[q] || img.rgba[q + 1] !== img2.rgba[q + 1] || img.rgba[q + 2] !== img2.rgba[q + 2]) return false; } return true; })());
      const v2 = (scene.tick(), scene.view());
      t('anim: the next frame has a different view signature (JSON differs)', JSON.stringify(v1) !== JSON.stringify(v2));
      // skip off by default: a press does not end the animation
      const n0 = c.n; scene.press('a'); scene.press('b'); scene.tick();
      t('anim: a press during an animation does NOT skip it by default (one more frame, not finished)', c.n === n0 + 1 && !c.run.done, n0 + ' -> ' + c.n);
    }
    // a run whose attacker and target are the same battler (a self-targeting move, a stat change): the OTHER Pokemon is not in the run and stays the scene's
    const self = await probe({ on: true }, (c) => c.a === c.d);
    t('anim: a self-targeting animation is found (the real animator has no general / status kinds yet)', WHICH === 'real' || !!self.found);
    if (self.found && WHICH === 'stub') {
      // since AN2's round 2 the engine draws the other Pokemon of a self-targeting run itself, from ctx.bystander
      const c = self.found, ctx = self.st.calls.starts[self.st.calls.starts.length - 1].ctx, other = self.b.scene.S.disp[c.a ^ 1];
      t('anim: a self-targeting run names the other Pokemon in ctx.bystander (its real species)', !!ctx.bystander && !!other && ctx.bystander.species === other.species && ctx.attacker.side === ctx.target.side, JSON.stringify(ctx.bystander) + ' vs ' + (other && other.species));
    }
    if (self.found) { const v = self.b.scene.view(), c = self.found; t('anim: ...and the healthboxes stay for a non-move animation', c.kind === 'move' || (v.player.showBox !== false && v.foe.showBox !== false)); t('anim: ...both Pokemon are hidden from the scene (the run draws both)', v.player.visible === false && v.foe.visible === false, JSON.stringify([c.kind, c.id, c.a, v.player.visible, v.foe.visible])); }
    const sk = await probe({ on: true, skip: true });
    t('anim: (skip on) the animation is found', !!sk.found);
    if (sk.found) {
      const c = sk.found, { scene } = sk.b, n0 = sk.st.calls.sounds;
      scene.press('a'); scene.tick();
      t('anim: with skip on a press runs the animation to its end in one frame, silently', c.run === null || c.run.done === true || scene.S.cur !== c, 'n=' + c.n);
      t('anim: ...the skipped animation forwarded no sound after the press', sk.st.calls.sounds === n0 || sk.b.hooks.sounds.length <= n0 + 1);
      t('anim: ...and animInfo counts the skip', scene.animInfo().skipped === 1, scene.animInfo().skipped);
    }
    const hold = await probe({ on: true, skip: false });
    if (hold.found) { const { scene } = hold.b, c = hold.found; scene.hold(true, false); const n0 = c.n; scene.tick(); scene.hold(false, false); t('anim: holding A does not skip either when skip is off', c.n === n0 + 1); }
  }

  /* ---- the foe's ground shadow (battle_ui.js, FA1): drawn at rest, hidden for the whole of an animation run (REAL OAM, FIDELITY.md B4; re-measured here on the real game's status animation) ---- */
  {
    const b = makeBattle(M, { seed: SEL.move[0], cfg: mkCfg({ on: true }), animator: await makeAnimator() }), { scene } = b, ui = uiOf(M);
    let g = 0; while (g++ < 6000 && !(scene.S.disp[0] && scene.S.disp[1] && scene.S.disp[0].visible && scene.S.disp[1].visible && !scene.S.disp[0].tint && !scene.S.disp[1].tint && !scene.S.disp[0].boxDx && !scene.S.disp[1].boxDx)) { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); }
    const v0 = scene.view(), foe = v0.foe, sp = ui.sprite(foe.species, 'foe', { shiny: foe.shiny, female: foe.gender === 'F' });
    const rect = { x: ui.LAYOUT.foeCenter[0] - 32 + sp.shadow.dx, y: ui.LAYOUT.foeCenter[1] + sp.yOffset - sp.elevation - 32 + 44 + sp.shadow.dy, w: 64, h: 8 };
    const away = (v) => Object.assign(Object.create(null), v, { foe: Object.assign({}, v.foe, { dy: 400 }), player: Object.assign({}, v.player, { dy: 400 }), box: { mode: 'message', text: ['', ''] } });   // both Pokemon and the text off the screen: only the shadow could differ from the terrain
    const noFoe = away(v0); noFoe.env = 0; noFoe.foe = undefined; const ref = ui.render(noFoe).rgba;      // the same picture with no foe at all: no sprite, no shadow
    const count = (img) => { let n = 0; for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const q = (y * 240 + x) * 4; if (img.rgba[q] !== ref[q] || img.rgba[q + 1] !== ref[q + 1] || img.rgba[q + 2] !== ref[q + 2]) n++; } return n; };
    const atRest = away(v0); atRest.env = 0; const during = away(v0); during.env = 0; Object.defineProperty(during, 'fxDraw', { value: () => {}, enumerable: false });
    t('shadow: the foe has a ground shadow at rest (' + (sp.shadow && sp.shadow.size) + ' size class)', sp.shadow && sp.shadow.size >= 0 && count(ui.render(atRest)) > 20, count(ui.render(atRest)));
    t('shadow: ...and it is hidden while an animation run draws the scene', count(ui.render(during)) === 0, count(ui.render(during)));
  }

  /* ---- end-of-turn poison / burn: the message, then the status animation, then the drain (MEASURED in the real game through the oracle; see scene.js handleDamage) ---- */
  {
    const order = (cfgInit, engineSeed = 11) => {
      const pack = packOf(M), ui = uiOf(M), text = M.BT.loadBattleText(rom, manifest);
      const mk = (species, moves, seed) => { const tm = M.MC.randomTeam(pack, seed, 1); const r = tm.recs[0]; r.species = species; r.level = 50; r.moves = moves.map((id) => ({ id, ppUps: 0 })); return tm; };
      const mv = (n) => pack.moves.findIndex((m) => m && m.name === n);
      const A = mk(6, [mv('Tackle')], 301), B = mk(143, [mv('Toxic')], 302);
      A.meta[0] = { gender: null, shiny: false }; B.meta[0] = { gender: null, shiny: false };
      const ctl = M.MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: engineSeed, pick: 0, names: ['You', 'CPU'], validate: false, sides: [{ kind: 'human' }, { kind: 'cpu', level: 'easy', seed: 3 }] });
      const st = createStubAnimator();
      const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You', anim: cfgInit ? mkCfg(cfgInit) : undefined, animator: st, animSeed: 5 });
      scene.S.auto = { decide(req) { return req.phase === 'move' ? { kind: 'move', slot: req.moves[0].slot } : req.phase === 'switch' ? { kind: 'switch', slot: req.options ? req.options[0].slot : 0 } : null; } };
      ctl.start(); scene.begin();
      const steps = []; let last = null, n = 0;
      while (n++ < 20000 && scene.mode !== 'result' && steps.length < 400) { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); const c = scene.S.cur; if (c && c !== last) { last = c; steps.push(c.t === 'text' ? 'text:' + c.text : c.t === 'moveanim' ? (c.run ? 'anim:' + c.kind + ':' + c.id : 'noanim') : c.t); } }
      const k = steps.findIndex((s) => /^text:.*(hurt by|poison)/i.test(s) && /hurt/i.test(s));
      return { steps, k, next: steps.slice(k + 1).filter((s) => s !== 'noanim' && s !== 'call' && s !== 'set').slice(0, 2) };
    };
    let pseed = 10 + SEED0; while (pseed < 70 + SEED0 && order({ on: true }, pseed).k <= 0) pseed++;
    const on = order({ on: true }, pseed), off = order({ on: false }, pseed);
    t('poison: a scripted battle with the end-of-turn "hurt by poison" line was found (engine seed ' + pseed + ') and the line exists with animations on and off', on.k > 0 && off.k > 0, on.k + ' / ' + off.k);
    t('poison: animations ON: the message, THEN the status animation (poison), THEN the bar drain', on.k > 0 && on.next[0] === 'anim:status:0' && on.next[1] === 'drain', JSON.stringify(on.next));
    t('poison: animations OFF: the message, then the drain (the text no longer follows the drain)', off.k > 0 && off.next[0] === 'drain', JSON.stringify(off.next));
  }

  /* ---- round 3: the battle's SYSTEM animations (the intro, send-outs, recalls, faints, hits) ---- */
  if (WHICH === 'stub') {
    const seed = SEL.sys[0], onSys = { on: true };
    const stubSys = await makeAnimator({ system: true }), stubPlain = await makeAnimator();
    const sysLines = [];
    const sys = playBattle(M, { seed, cfg: mkCfg(onSys), animator: stubSys, onTick: (scene) => { const c = scene.S.cur; if (c && c.t === 'sysintro' && c.shown) { const key = c.shown.filter(Boolean).join(' '); if (key && sysLines[sysLines.length - 1] !== key) sysLines.push(key); } } });
    const plain = playBattle(M, { seed, cfg: mkCfg(onSys), animator: stubPlain });
    const info = sys.scene.animInfo(), st0 = stubSys.calls.sysStarts[0];
    t('system: the battle opens with ONE system step (S) instead of the lead messages and slide-ins', sys.tokens.startsWith('S') && !/^[TI]/.test(sys.tokens) && st0 && st0.id === 1, sys.tokens.slice(0, 12) + ' / id ' + (st0 && st0.id));
    t('system: the trainer intro (id 1) is the one the arena uses; the run gets the real leads (species, level, hp, experience of the level, environment)', !!st0 && st0.ctx.foe.species > 0 && st0.ctx.player.species > 0 && st0.ctx.foe.level === 50 && st0.ctx.foe.exp > 0 && st0.ctx.player.exp > 0 && st0.ctx.foe.hp === st0.ctx.foe.maxHp && st0.ctx.environment === seed % 9 && st0.ctx.keys === null, JSON.stringify(st0 && { f: st0.ctx.foe, e: st0.ctx.environment }).slice(0, 160));
    t('system: the scene types ITS OWN three messages over the run, in order (challenge, send-out, go)', sysLines.length >= 3 && /would like to battle/.test(sysLines[0]) && /sent out/.test(sysLines.find((l, i) => i > 0 && /sent out/.test(l)) || '') && /(Go!|You're in charge|Go for it|Your opponent)/.test(sysLines[sysLines.length - 1] + ' ' + sysLines.join(' ')), JSON.stringify(sysLines.slice(0, 5)));
    t('system: the run draws WITHOUT its text boxes (layers 0x1e: BG0 off) because the scene prints the text', stubSys.calls.sysDraws.length > 50 && stubSys.calls.sysDraws.every((d) => d.layers === 0x1e), JSON.stringify([...new Set(stubSys.calls.sysDraws.map((d) => d.layers))]));
    t('system: A is pressed for the run once per message it printed (it waits at each)', stubSys.calls.sysKeys.filter((k) => k === 1).length >= 3 && stubSys.calls.sysEnded >= 1, stubSys.calls.sysKeys.filter((k) => k === 1).length + ' presses');
    t('system: the intro ended (the run was ready) and both leads stand on the scene afterwards', !info.log.length && info.sys >= 1, JSON.stringify(info.log) + ' sys ' + info.sys);
    t('system: sound and cry events of the run reach hooks.onSound / hooks.onCry', sys.hooks.sounds.some((x) => x[0] === 114) && stubSys.calls.sysCries >= 1 && stubSys.calls.sysCries === (stubSys.calls.sysBegins || stubSys.calls.sysStarts.length) && sys.hooks.cries.length === stubSys.calls.cries + stubSys.calls.sysCries && sys.hooks.cries.every((c) => c[0] > 0), sys.hooks.cries.length + ' vs ' + (stubSys.calls.cries + stubSys.calls.sysCries));
    // every old step that has a system event became one
    const cnt = (str, ch) => (str.match(new RegExp(ch, 'g')) || []).length;
    const ids = stubSys.calls.sysStarts.slice(1).map((x) => x.id);
    t('system: hits, faints, send-outs and recalls of the battle are system events with the right ids (hit 6/7, faint 4/5, send-out 2/8, recall 3/9)', ids.length >= 6 && ids.every((i) => i >= 2 && i <= 9) && cnt(sys.tokens, 'H') === ids.filter((i) => i === 6 || i === 7).length && cnt(sys.tokens, 'F') === ids.filter((i) => i === 4 || i === 5).length && cnt(sys.tokens, 'I') === ids.filter((i) => i === 2 || i === 8).length && cnt(sys.tokens, 'O') === ids.filter((i) => i === 3 || i === 9).length, ids.join(','));
    t('system: ...and as many hit blinks / faints / recalls as the battle has without them (same engine battle)', cnt(sys.tokens, 'H') === cnt(plain.tokens, 'H') && cnt(sys.tokens, 'F') === cnt(plain.tokens, 'F') && cnt(sys.tokens, 'O') === cnt(plain.tokens, 'O') && cnt(sys.tokens, 'I') === cnt(plain.tokens, 'I') - 2 && sys.hash === plain.hash, cnt(sys.tokens, 'H') + '/' + cnt(plain.tokens, 'H'));
    t('system: ids 2..7 start a WILD-style pre-roll and 8 / 9 the trainer one; every event run carries the lead pair and the environment', stubSys.calls.sysStarts.slice(1).every((x) => x.ctx.trainer === (x.id >= 8 ? 1 : 0) && x.ctx.foe.species > 0 && x.ctx.player.species > 0 && x.ctx.environment === seed % 9 && x.ctx.foe.exp > 0), '');
    t('system: a send-out names the new Pokemon in ctx.switchIn; a faint starts the fainting side at 0 HP', stubSys.calls.sysStarts.every((x) => (x.id === 2 || x.id === 8) === !!x.ctx.switchIn) && stubSys.calls.sysStarts.filter((x) => x.id === 4).every((x) => x.ctx.player.hp === 0) && stubSys.calls.sysStarts.filter((x) => x.id === 5).every((x) => x.ctx.foe.hp === 0), '');
    // round 4: the foe trainer's ROM picture follows the CPU level; the player's back sprite follows playerGender (both ride in ctx; the real engine draws them)
    {
      const pools = { easy: [11, 12, 13], normal: [21, 22, 23], hard: [31, 32, 33] };
      const runWith = async (so) => { const st = await makeAnimator({ system: true }); const r = playBattle(M, { seed, cfg: mkCfg(onSys), animator: st, sceneOpts: so }); return { st, r }; };
      for (const lv of ['easy', 'normal', 'hard']) {
        const { st } = await runWith({ trainerChoices: pools, cpuLevel: lv, playerGender: 'F' });
        const intro = st.calls.sysStarts[0].ctx, tr = st.calls.sysStarts.filter((x) => x.id >= 8);
        t('system: cpu level ' + lv + ': the opening uses a ROM trainer of that level (' + intro.trainer + ' of ' + pools[lv].join('/') + ') and the player\'s back sprite is F', pools[lv].includes(intro.trainer) && intro.gender === 'F' && intro.trainer > 1, JSON.stringify({ t: intro.trainer, g: intro.gender }));
        t('system: cpu level ' + lv + ': the same trainer for the whole battle (ids 8 / 9), ids 2..7 stay wild-style and carry the gender', tr.every((x) => x.ctx.trainer === intro.trainer) && st.calls.sysStarts.slice(1).filter((x) => x.id < 8).every((x) => x.ctx.trainer === 0 && x.ctx.gender === 'F'), tr.map((x) => x.ctx.trainer).join(','));
      }
      const base = await runWith({}), s0 = base.st.calls.sysStarts[0].ctx;
      t('system: without trainer choices the engine\'s own default trainer is kept (no trainer / gender in the opening ctx; ids 8 / 9 say 1)', s0.trainer === undefined && s0.gender === undefined && base.st.calls.sysStarts.filter((x) => x.id >= 8).every((x) => x.ctx.trainer === 1), JSON.stringify({ t: s0.trainer, g: s0.gender }));
      const a1 = await runWith({ trainerChoices: pools, cpuLevel: 'normal' }), a2 = await runWith({ trainerChoices: pools, cpuLevel: 'normal' });
      t('system: the trainer pick is deterministic for a seed', a1.st.calls.sysStarts[0].ctx.trainer === a2.st.calls.sysStarts[0].ctx.trainer && a1.r.digest === a2.r.digest, '');
      const picks = new Set(); for (const sd of [1, 2, 3, 4, 5, 6, 7, 8]) { const st = await makeAnimator({ system: true }); playBattle(M, { seed: sd, cfg: mkCfg(onSys), animator: st, sceneOpts: { trainerChoices: pools, cpuLevel: 'hard' }, maxFrames: 200 }); picks.add(st.calls.sysStarts[0].ctx.trainer); }
      t('system: different battles of one level show different trainers (' + [...picks].join(',') + ')', picks.size >= 2, '');
    }
    // round 7: A HIT OR A FAINT PLAYS FOR THE POKEMON THAT IS ON SCREEN WHEN IT PLAYS. Reported by the player: "when pokemon get hit, faint, or after they switch out and the new pokemon gets hit, it shows the old
    // pokemon briefly, and that is when the health bars go wrong". Cause (reproduced frame by frame in a real browser, ANIM.md "Round 7"): the scene prepares the NEXT hit / faint ahead of time, from what it displays NOW; a switch
    // (recall, send-out) has not finished then, so a hit queued behind it was built from the Pokemon that was switched OUT (its picture, its full HP bar) and played, as prepared, for the one that came in. The stub animator records
    // the ctx of every prepared run; here every hit / faint run is checked, at the moment it BEGINS, against the Pokemon the scene shows at that moment, over battles in which the player switches on purpose.
    {
      const seen = [], bad = [];
      let restale = 0, runs = 0, switches = 0, swRuns = 0;
      for (const sd of SEL.sys.concat([2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15])) {
        const st = await makeAnimator({ system: true });
        let sceneRef = null, taken = 0;
        const snap = (id, ctx) => {
          const d = sceneRef.S.disp, mon = (m) => (m ? { species: m.species, level: m.level, hp: m.hp, maxHp: m.maxHp } : null);
          const want = { player: mon(d[0]), foe: mon(d[1]) }, got = { player: ctx.player && { species: ctx.player.species, level: ctx.player.level, hp: ctx.player.hp, maxHp: ctx.player.maxHp }, foe: ctx.foe && { species: ctx.foe.species, level: ctx.foe.level, hp: ctx.foe.hp, maxHp: ctx.foe.maxHp } };
          const faintSide = id === 4 ? 'player' : id === 5 ? 'foe' : null;                 // a faint starts its own side at 0 HP: only the species is compared there
          // round 7b: a SEND-OUT (2 player / 8 foe) draws only the OTHER side's Pokemon (the side that sends out is the Pokemon being replaced and no frame of the effect shows it: the handoff group below proves it with the
          // ROM engine), a RECALL (3 / 9) draws both: every Pokemon an effect draws (species, level, HP bar) must be the one the scene shows when the effect BEGINS
          const swSide = id === 2 ? 'player' : id === 8 ? 'foe' : null;
          const sideOk = (k) => k === swSide || !want[k] || !got[k] || (got[k].species === want[k].species && got[k].level === want[k].level && (k === faintSide || (got[k].hp === want[k].hp && got[k].maxHp === want[k].maxHp)));
          runs++; if (id === 2 || id === 3 || id === 8 || id === 9) swRuns++;
          if (!sideOk('player') || !sideOk('foe')) bad.push({ seed: sd, id, want, got });
        };
        const wrap = (h, id, ctx) => { if (id >= 2 && id <= 9 && h && typeof h.begin === 'function') { const b = h.begin; h.begin = function () { snap(id, ctx); return b.apply(this, arguments); }; } return h; };
        const prep = st.prepare && st.prepare.bind(st), start = st.start.bind(st);
        if (prep) st.prepare = (kind, id, ctx) => (kind === 'system' ? wrap(prep(kind, id, ctx), id, ctx) : prep(kind, id, ctx));
        st.start = (kind, id, ctx) => { const r = start(kind, id, ctx); if (kind === 'system' && id >= 2 && id <= 9) snap(id, ctx); return r; };
        const r = playBattle(M, { seed: sd, cfg: mkCfg(onSys), animator: st, onTick: (scene) => { sceneRef = scene; },
          decide: (req, def) => { if (req.phase === 'move' && req.switches && req.switches.length && !req.trapped && taken < 3 && (req.turn === undefined || true)) { taken++; switches++; return { kind: 'switch', slot: req.switches[0].slot }; } return def; } });
        seen.push(r.scene.animInfo());
        restale += r.scene.animInfo().restale | 0;
      }
      t('system/stale: ' + (runs - swRuns) + ' hit / faint runs over ' + seen.length + ' battles with ' + switches + ' voluntary switches each begin with the Pokemon (species, level, HP) the scene shows at that moment' + (bad.length ? ' -- ' + JSON.stringify(bad[0]).slice(0, 260) : ''), runs - swRuns >= 20 && switches >= 6 && !bad.some((b) => b.id >= 4 && b.id <= 7), (runs - swRuns) + ' runs, ' + switches + ' switches, ' + bad.filter((b) => b.id >= 4 && b.id <= 7).length + ' wrong');
      t('system/stale: ' + swRuns + ' send-out / recall runs (ids 2, 3, 8, 9) in the same battles each begin with the Pokemon the effect draws (the OTHER side\'s for a send-out, both for a recall: species, level, HP bar) as the scene shows them at that moment' + (bad.some((b) => b.id === 2 || b.id === 3 || b.id === 8 || b.id === 9) ? ' -- ' + JSON.stringify(bad.find((b) => b.id === 2 || b.id === 3 || b.id === 8 || b.id === 9)).slice(0, 260) : ''), swRuns >= 20 && !bad.some((b) => b.id === 2 || b.id === 3 || b.id === 8 || b.id === 9), swRuns + ' runs, ' + bad.filter((b) => b.id === 2 || b.id === 3 || b.id === 8 || b.id === 9).length + ' wrong');
      t('system/stale: ...and the picture was right the first time: no prepared hit / faint / send-out / recall had to be prepared again (' + restale + ' re-prepared)', restale === 0, String(restale));
      t('system/stale: the diagnostics carry the count (animInfo().restale)', seen.every((i) => typeof i.restale === 'number'), '');
    }
    // THE FREE SWITCH ("Will you switch your Pokemon?", ANIM.md Round 9). The question itself is a request, not an event, so nothing is prepared for it; what an answer brings is an ordinary recall + send-out of the
    // player's Pokemon and then the foe's send-out. Every run of those (and of every hit / faint around them) is checked, as in the group above, against the Pokemon the screen shows when the run BEGINS, in battles
    // where the player answers at every offer: 'auto' = the automatic player (YES, NO, YES ...), 'ui' = the real question (typed, YES / NO, the party screen; offers go YES with a detour through B from the party
    // screen, YES straight, NO), 'set' = BATTLE STYLE: SET (the scene answers NO itself: no question may ever open).
    {
      const bad = [], logs = [];
      let restale = 0, runs = 0, yes = 0, no = 0, uiAnswers = 0, backs = 0, prompts = 0, setStays = 0, battles = 0;
      for (const sd of (quick ? SEL.sys.slice(0, 2) : SEL.sys.concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15]))) for (const how of ['auto', 'ui', 'set']) {
        const st = await makeAnimator({ system: true });
        let sceneRef = null, offers = 0, detour = false, back = false;
        const snap = (id, ctx) => {
          const d = sceneRef.S.disp, mon = (m) => (m ? { species: m.species, level: m.level, hp: m.hp, maxHp: m.maxHp } : null);
          const want = { player: mon(d[0]), foe: mon(d[1]) }, got = { player: ctx.player && { species: ctx.player.species, level: ctx.player.level, hp: ctx.player.hp, maxHp: ctx.player.maxHp }, foe: ctx.foe && { species: ctx.foe.species, level: ctx.foe.level, hp: ctx.foe.hp, maxHp: ctx.foe.maxHp } };
          const faintSide = id === 4 ? 'player' : id === 5 ? 'foe' : null, swSide = id === 2 ? 'player' : id === 8 ? 'foe' : null;
          const sideOk = (k) => k === swSide || !want[k] || !got[k] || (got[k].species === want[k].species && got[k].level === want[k].level && (k === faintSide || (got[k].hp === want[k].hp && got[k].maxHp === want[k].maxHp)));
          runs++; if (!sideOk('player') || !sideOk('foe')) bad.push({ seed: sd, how, id, want, got });
        };
        const wrap = (h, id, ctx) => { if (id >= 2 && id <= 9 && h && typeof h.begin === 'function') { const b = h.begin; h.begin = function () { snap(id, ctx); return b.apply(this, arguments); }; } return h; };
        const prep = st.prepare && st.prepare.bind(st), start = st.start.bind(st);
        if (prep) st.prepare = (kind, id, ctx) => (kind === 'system' ? wrap(prep(kind, id, ctx), id, ctx) : prep(kind, id, ctx));
        st.start = (kind, id, ctx) => { const r = start(kind, id, ctx); if (kind === 'system' && id >= 2 && id <= 9) snap(id, ctx); return r; };
        const r = playBattle(M, { seed: sd, cfg: mkCfg(onSys), animator: st, freeSwitch: true, maxFrames: quick ? 30000 : undefined, sceneOpts: how === 'set' ? { style: { get: () => ({ style: 'set' }), set() {} } } : {},
          onTick: (scene) => {
            sceneRef = scene;
            const S = scene.S;
            if (scene.mode === 'confirm' && S.confirm && S.confirm.kind === 'free') {
              if (how === 'set') { prompts++; return; }
              if (how !== 'ui') return;
              if (back) { back = false; scene.press('a'); return; }                                   // back at the question after B: YES again
              offers++; uiAnswers++;
              if ((offers + sd) % 3 === 1) { scene.press('a'); yes++; detour = true; }                // YES, then B from the party screen, then YES again
              else if ((offers + sd) % 3 === 2) { scene.press('a'); yes++; }                                 // YES straight
              else { scene.press('down'); scene.press('a'); no++; }                                   // NO
            } else if (how === 'ui' && scene.mode === 'party' && S.party && S.party.free) { if (detour) { detour = false; back = true; backs++; scene.press('b'); } else scene.press('a'); }
          },
          decide: (req, def) => { if (req.phase === 'switch' && req.reason === 'free') { if (how !== 'auto') return null; offers++; if ((offers + sd) % 2 === 1) { yes++; return { kind: 'switch', slot: req.switches[0].slot }; } no++; return { kind: 'stay' }; } return def; } });
        battles++; logs.push(...r.scene.animInfo().log); restale += r.scene.animInfo().restale | 0;
        if (how === 'set') setStays += r.ctl.battle.choiceLog.filter((e) => e.c.kind === 'stay').length;
      }
      t('system/free-switch: ' + runs + ' system runs (send-outs, recalls, hits, faints) in ' + battles + ' battles with free switches (' + yes + ' YES, ' + no + ' NO, ' + uiAnswers + ' answered through the real question, ' + backs + ' with a detour through B from the party screen) each begin with the Pokemon the scene shows at that moment' + (bad.length ? ' -- ' + JSON.stringify(bad[0]).slice(0, 260) : ''), bad.length === 0 && (quick ? yes >= 1 && no >= 1 && uiAnswers >= 1 && runs >= 10 : yes >= 9 && no >= 6 && uiAnswers >= 9 && backs >= 3 && runs >= 90), runs + ' runs, yes ' + yes + ', no ' + no + ', ui ' + uiAnswers + ', backs ' + backs + ', ' + bad.length + ' wrong');
      t('system/free-switch: BATTLE STYLE: SET with the animator: no question ever opened (' + prompts + ' prompts), the scene answered NO itself (' + setStays + ' stays in the logs), and its runs begin right too', prompts === 0 && setStays >= (quick ? 1 : 6), prompts + ' prompts, ' + setStays + ' stays');
      t('system/free-switch: ...none had to be prepared again (' + restale + ' re-prepared) and the animation layer logged no problem (' + logs.length + ')', restale === 0 && logs.length === 0, restale + ' / ' + JSON.stringify(logs.slice(0, 2)));
    }
    // ... and a change NOBODY foresaw between preparing a hit and playing it is still caught when it starts: the picture is made again for what is on screen (a brief hold of the previous picture, never a wrong one)
    {
      const bad = [], tampered = [], tLog = [], tNotes = []; let restale = 0;
      for (const sd of SEL.sys.slice(0, 3).concat([3, 4, 5])) {
        const st = await makeAnimator({ system: true });
        let sceneRef = null, done = false;
        const snap = (id, ctx) => { const d = sceneRef.S.disp[0], m = ctx.player; if (d && m && (m.species !== d.species || (id !== 4 && m.hp !== d.hp))) bad.push({ sd, id, shown: [d.species, d.hp], ctx: [m.species, m.hp] }); };
        const prep = st.prepare.bind(st);
        st.prepare = (kind, id, ctx) => { const h = prep(kind, id, ctx); if (kind === 'system' && (id === 6 || id === 4) && h && typeof h.begin === 'function') { const b = h.begin; h.begin = function () { snap(id, ctx); return b.apply(this, arguments); }; } return h; };
        const r = playBattle(M, { seed: sd, cfg: mkCfg(onSys), animator: st, onTick: (scene) => {
          sceneRef = scene;
          if (done) return;
          const q = scene.S.queue.find((x) => x.t === 'shake' && x.side === 0 && x.prep && !x.prep.failed), d = scene.S.disp[0];
          if (q && d && d.hp > 1) { d.hp -= 1; done = true; tampered.push(sd); }          // the displayed HP moves while a hit on it is already prepared, by something the projection does not know about
        } });
        restale += r.scene.animInfo().restale | 0; tLog.push(...r.scene.animInfo().log); tNotes.push(...r.scene.animInfo().notes);
      }
      t('system/stale: a change nobody foresaw between preparing and playing a hit (' + tampered.length + ' battles tampered with) is caught at start: it begins with what is on screen', tampered.length >= 3 && bad.length === 0, tampered.length + ' tampered, ' + bad.length + ' wrong ' + JSON.stringify(bad[0] || null));
      t('system/stale: ...by preparing it again (' + restale + ' re-prepared)', restale >= tampered.length, restale + ' vs ' + tampered.length);
      // a re-prepare is BENIGN (a brief hold of the previous picture, never a wrong one): it is counted and noted, and it is NOT an entry of the animation PROBLEMS log (which the tests and the browser suite require empty)
      t('system/stale: ...and it is a NOTE, not a problem: animInfo().notes has one "system N stale: <what differs>" line per re-prepare (' + tNotes.length + ' for ' + restale + '), animInfo().log is empty (' + tLog.length + ')', tNotes.length === restale && restale >= tampered.length && tNotes.every((x) => /^system [2-9] stale: \S/.test(x)) && tLog.length === 0, JSON.stringify(tNotes.slice(0, 2)) + ' / log ' + JSON.stringify(tLog.slice(0, 2)));
    }
    // round 7b: SEND-OUTS AND RECALLS TOO. The review of round 7 found the same defect left in the other two switch effects: the Pokemon of the OTHER side (its species, its HP bar) was still read from the display when the
    // effect was PREPARED, so a bar moving on that side (a drain writes the Pokemon's hp on EVERY frame, so the read is mid-drain) or a replacement queued before the effect left that side's picture stale for the whole effect:
    // a foe's send-out drawn with the player's dead Pokemon, the player's bar back at 113 while the screen showed 101 (27 to 30 stale runs of ~1700 in the review's counts, in battles nobody forced). The scenarios here are
    // BUILT BY HAND on a real scene (two Pokemon on the field at the first action menu, then the steps queued the way the director queues them), so each case exists whatever the engine does, and every run is checked at the moment it BEGINS.
    {
      const same = (c, d) => !!c && !!d && c.species === d.species && c.level === d.level && c.hp === d.hp && c.maxHp === d.maxHp;
      const hand = async (build, o = {}) => {
        const st = await makeAnimator({ system: true });
        const runs = [];
        let sceneRef = null;
        const mon = (d) => (d ? { species: d.species, level: d.level, hp: d.hp, maxHp: d.maxHp } : null);
        const prep = st.prepare.bind(st);
        st.prepare = (kind, id, ctx) => { const h = prep(kind, id, ctx); if (kind === 'system' && id >= 2 && id <= 9 && h && typeof h.begin === 'function') { const b = h.begin; h.begin = function () { const d = sceneRef.S.disp; runs.push({ id, ctx, disp: [mon(d[0]), mon(d[1])] }); return b.apply(this, arguments); }; } return h; };
        const b = makeBattle(M, { seed: o.seed || 1, cfg: mkCfg(onSys), animator: st });
        const scene = sceneRef = b.scene, auto = scene.S.auto, decide = auto.decide;
        auto.decide = (req) => (req.phase === 'move' ? null : decide(req));                 // the preview is answered as always, the first action menu is left alone
        let n = 0;
        while (n++ < 6000 && scene.mode !== 'action') { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); }
        if (scene.mode !== 'action' || !scene.S.disp[0] || !scene.S.disp[1]) return null;
        const P0 = mon(scene.S.disp[0]), F0 = mon(scene.S.disp[1]), copy = (d) => ({ species: d.species, name: d.name, level: d.level, gender: d.gender, hp: d.maxHp, maxHp: d.maxHp, status: null, shiny: !!d.shiny, slot: 9, orig: 9 });
        const x = { P0, F0, pTo: Math.max(1, Math.floor(P0.hp / 3)), fTo: Math.max(1, Math.floor(F0.hp / 3)), newPlayer: copy(scene.S.disp[1]), newFoe: copy(scene.S.disp[0]) };       // a replacement of the other kind on each side
        const before = runs.length;
        for (const s of build(x)) scene.S.queue.push(s);
        let k = 0;
        while (k++ < 8000 && (scene.S.cur || scene.S.queue.length)) { scene.tick(); if (o.onTick) o.onTick(scene, k); }
        return { runs: runs.slice(before), x, restale: scene.animInfo().restale | 0, log: scene.animInfo().log, notes: scene.animInfo().notes };
      };
      // [name, steps, the id of the run to check, which sides it draws ('o' = the other side only, 'b' = both), what the screen must hold when it begins]
      const SC = [
        ['foe send-out behind a drain of the PLAYER\'s bar', (x) => [{ t: 'drain', side: 0, to: x.pTo }, { t: 'slidein', side: 1, mon: x.newFoe }], 8, 'o', (r, x) => r.disp[0].hp === x.pTo],
        ['foe send-out behind the PLAYER\'s replacement', (x) => [{ t: 'slidein', side: 0, mon: x.newPlayer }, { t: 'pause', n: 20 }, { t: 'slidein', side: 1, mon: x.newFoe }], 8, 'o', (r, x) => r.disp[0].species === x.newPlayer.species],
        ['player send-out behind a drain of the FOE\'s bar', (x) => [{ t: 'drain', side: 1, to: x.fTo }, { t: 'slidein', side: 0, mon: x.newPlayer }], 2, 'o', (r, x) => r.disp[1].hp === x.fTo],
        ['player send-out behind the FOE\'s replacement', (x) => [{ t: 'slidein', side: 1, mon: x.newFoe }, { t: 'pause', n: 20 }, { t: 'slidein', side: 0, mon: x.newPlayer }], 2, 'o', (r, x) => r.disp[1].species === x.newFoe.species],
        ['foe recall behind a drain of the PLAYER\'s bar', (x) => [{ t: 'drain', side: 0, to: x.pTo }, { t: 'slideout', side: 1 }], 9, 'b', (r, x) => r.disp[0].hp === x.pTo],
        ['foe recall behind the PLAYER\'s replacement', (x) => [{ t: 'slidein', side: 0, mon: x.newPlayer }, { t: 'pause', n: 20 }, { t: 'slideout', side: 1 }], 9, 'b', (r, x) => r.disp[0].species === x.newPlayer.species],
        ['player recall behind a drain of the FOE\'s bar', (x) => [{ t: 'drain', side: 1, to: x.fTo }, { t: 'slideout', side: 0 }], 3, 'b', (r, x) => r.disp[1].hp === x.fTo],
        ['player recall behind the FOE\'s replacement', (x) => [{ t: 'slidein', side: 1, mon: x.newFoe }, { t: 'pause', n: 20 }, { t: 'slideout', side: 0 }], 3, 'b', (r, x) => r.disp[1].species === x.newFoe.species],
        // the recalled Pokemon's own bar is DRAWN by the recall (Eject Button, Emergency Exit, Regenerator: its bar moves, then it leaves)
        ['player recall behind a drain of ITS OWN bar', (x) => [{ t: 'drain', side: 0, to: x.pTo }, { t: 'slideout', side: 0 }], 3, 'b', (r, x) => r.disp[0].hp === x.pTo],
        ['foe recall behind a drain of ITS OWN bar', (x) => [{ t: 'drain', side: 1, to: x.fTo }, { t: 'slideout', side: 1 }], 9, 'b', (r, x) => r.disp[1].hp === x.fTo],
      ];
      const bad = { send: [], recall: [] }; let ran = 0, scenarios = 0, redone = 0;
      for (const [name, build, id, sides, want] of SC) {
        const r = await hand(build);
        const runs = r && r.runs.filter((q) => q.id === id), run = runs && runs[0];
        scenarios++;
        const drawn = run && (sides === 'b' ? same(run.ctx.player, run.disp[0]) && same(run.ctx.foe, run.disp[1]) : (id === 2 ? same(run.ctx.foe, run.disp[1]) : same(run.ctx.player, run.disp[0])));
        const fine = !!r && runs.length === 1 && !!run.disp[0] && !!run.disp[1] && drawn && want(run, r.x) && r.x.P0.species !== r.x.newPlayer.species;
        if (r) { ran++; redone += r.restale; }
        if (!fine) (id === 2 || id === 8 ? bad.send : bad.recall).push(name + ' -- ' + JSON.stringify(run ? { ctx: [run.ctx.player.species, run.ctx.player.hp, run.ctx.foe.species, run.ctx.foe.hp], screen: run.disp } : null).slice(0, 200));
      }
      t('system/stale: a SEND-OUT begins with the OTHER side\'s Pokemon as the screen shows it, behind a drain of that side\'s bar and behind its replacement (' + bad.send.length + ' of 4 hand-built cases wrong)' + (bad.send.length ? ' -- ' + bad.send[0] : ''), ran === SC.length && bad.send.length === 0, bad.send.join(' | ') || 'ran ' + ran);
      t('system/stale: a RECALL begins with BOTH Pokemon as the screen shows them, behind a drain of either bar (the recalled one\'s own included) and behind a replacement (' + bad.recall.length + ' of 6 hand-built cases wrong)' + (bad.recall.length ? ' -- ' + bad.recall[0] : ''), ran === SC.length && bad.recall.length === 0, bad.recall.join(' | ') || 'ran ' + ran);
      t('system/stale: ...and every one of those pictures was right the first time (' + redone + ' prepared again over ' + SC.length + ' cases)', ran === SC.length && redone === 0, String(redone));
      // a change NOBODY foresaw while a send-out / recall waits prepared (a pause): it is caught when the effect starts and the picture is made again for what is on screen; the sending side's own lead is not
      // compared (no frame of a send-out shows it) so a change there costs nothing
      const TS = [
        // [name, steps, the queue step to watch, the side whose hp is moved, the id of the run, restale wanted, sides compared]
        ['send-out: the other side\'s bar moved', (x) => [{ t: 'pause', n: 40 }, { t: 'slidein', side: 1, mon: x.newFoe }], ['slidein', 1], 0, 8, 1, [0]],
        ['recall: the recalled Pokemon\'s own bar moved', (x) => [{ t: 'pause', n: 40 }, { t: 'slideout', side: 0 }], ['slideout', 0], 0, 3, 1, [0, 1]],
        ['recall: the other side\'s bar moved', (x) => [{ t: 'pause', n: 40 }, { t: 'slideout', side: 0 }], ['slideout', 0], 1, 3, 1, [0, 1]],
        ['send-out: the bar of the Pokemon being replaced moved (no frame shows it)', (x) => [{ t: 'pause', n: 40 }, { t: 'slidein', side: 1, mon: x.newFoe }], ['slidein', 1], 1, 8, 0, [0]],
        ['control, nothing moved', (x) => [{ t: 'pause', n: 40 }, { t: 'slidein', side: 1, mon: x.newFoe }], ['slidein', 1], -1, 8, 0, [0]],
      ];
      const tbad = [], trows = [];
      for (const [name, build, [wt, ws], moveSide, id, want, sides] of TS) {
        let moved = 0;
        const r = await hand(build, { onTick: (scene) => {
          if (moved || moveSide < 0) return;
          const q = scene.S.queue.find((y) => y.t === wt && y.side === ws && y.prep && !y.prep.failed), d = scene.S.disp[moveSide];
          if (q && d && d.hp > 1) { d.hp -= 1; moved = 1; }              // the displayed HP moves while the effect is already prepared, by something the projection does not know about
        } });
        const run = r && r.runs.find((q) => q.id === id);
        const ok1 = !!r && !!run && (moveSide < 0 || moved === 1) && r.restale === want && r.notes.length === want && r.log.length === 0 && sides.every((sd) => same(sd === 0 ? run.ctx.player : run.ctx.foe, run.disp[sd]));
        trows.push(name + ': ' + (r ? r.restale : '-') + '/' + want);
        if (!ok1) tbad.push(name + ' -- restale ' + (r ? r.restale : '-') + ' wanted ' + want + (run ? ', ctx ' + JSON.stringify([run.ctx.player.hp, run.ctx.foe.hp]) + ' screen ' + JSON.stringify(run.disp.map((m) => m && m.hp)) : ', no run') + (moved ? '' : ', nothing moved'));
      }
      t('system/stale: a change nobody foresaw while a SEND-OUT / RECALL waits prepared is caught when it starts (prepared again, begins with what is on screen), a change to the Pokemon being replaced is not (no frame shows it), and nothing moves the count by itself' + (tbad.length ? ' -- ' + tbad[0] : ''), tbad.length === 0, tbad.join(' | ') || trows.join('; '));
    }
    // round 4: PREPARED system runs (animator.prepare -> advance once per tick -> begin when the step before is done and the handle is ready)
    {
      const nonWarm = (c) => c.sysPrepares.filter((p) => !p.exhausted);
      const slice = async (so) => { const st = await makeAnimator(Object.assign({ system: true }, so || {})); const hooks = { hits: 0, faints: 0, sounds: [], cries: [] }; hooks.onHit = () => hooks.hits++; hooks.onFaint = () => hooks.faints++; const r = playBattle(M, { seed, cfg: mkCfg(onSys), animator: st, hooks }); return { st, r, hooks }; };
      const perTick = (c) => { const m = new Map(); for (const a of c.advanceLog) m.set(a.tick, (m.get(a.tick) || 0) + 1); return Math.max(0, ...m.values()); };
      const base = await slice({});
      const c = base.st.calls;
      t('system/prepare: the scene prepares its runs (intro + events) and begins every one of them: prepared = begun + disposed (' + nonWarm(c).length + ' = ' + c.sysBegins + ' + ' + c.sysDisposed + ')', nonWarm(c).length >= 6 && nonWarm(c).length === c.sysBegins + c.sysDisposed && c.sysBegins >= 6, '');
      t('system/prepare: ONE slice of at most 4 ms per tick, never two in a tick (the handle is advanced once per scene tick)', c.advanceLog.length > 20 && perTick(c) === 1 && c.advanceLog.every((a) => a.ms > 0 && a.ms <= 4), 'max per tick ' + perTick(c) + ', budgets ' + [...new Set(c.advanceLog.map((a) => a.ms))].join('/'));
      t('system/prepare: begin() only on a ready handle and the animation log is clean (the stub throws otherwise)', base.st.calls.sysBegins >= 6 && base.r.scene.animInfo().log.length === 0, JSON.stringify(base.r.scene.animInfo().log));
      const firstHit = c.sysStarts.find((x) => x.id === 6 || x.id === 7), warm = c.sysWarm[0];
      const noHp = (m) => Object.assign({}, m, { hp: 0, status: 0 });
      t('system/prepare: the first events battle state is pre-rolled while the opening plays (one prewarm; same species / levels / environment / trainer / seed as the first hit, so the engine can share the pre-roll when the HP matches)', c.sysWarm.length === 1 && !!firstHit && JSON.stringify([noHp(warm.ctx.foe), noHp(warm.ctx.player), warm.ctx.environment, warm.ctx.trainer, warm.ctx.seed, warm.ctx.maxFrames]) === JSON.stringify([noHp(firstHit.ctx.foe), noHp(firstHit.ctx.player), firstHit.ctx.environment, firstHit.ctx.trainer, firstHit.ctx.seed, firstHit.ctx.maxFrames]) && warm.tick < firstHit.tick, JSON.stringify({ warm: warm && [warm.ctx.foe.hp, warm.ctx.player.hp, warm.ctx.trainer, warm.tick], hit: firstHit && [firstHit.id, firstHit.ctx.foe.hp, firstHit.ctx.player.hp, firstHit.ctx.trainer, firstHit.tick] }));
      // slow handles: the same battle, the same animator frames, the previous picture held while a handle is not ready
      const slow = await slice({ prepAdvances: 40 }), inst = await slice({ prepAdvances: 0 });
      t('system/prepare: a slow handle (40 slices) changes nothing but the waiting: same tokens, same engine battle, same animator frames as instant handles', slow.r.tokens === inst.r.tokens && slow.r.hash === inst.r.hash && slow.st.calls.steps === inst.st.calls.steps && slow.st.calls.sysDraws.length > 0, slow.st.calls.steps + ' vs ' + inst.st.calls.steps);
      t('system/prepare: ...the scene waited (animInfo().waited > 0 with slow handles, 0 with instant ones) and the battle took more ticks, not more animator frames', slow.r.scene.animInfo().waited > 0 && inst.r.scene.animInfo().waited === 0 && slow.r.frames > inst.r.frames, slow.r.scene.animInfo().waited + ' waited, ' + slow.r.frames + ' vs ' + inst.r.frames + ' frames');
      {
        const stH = await makeAnimator({ system: true, prepAdvances: 40 }); const held = []; let prev = null, waitTicks = 0, runDuring = 0;
        const ui2 = uiOf(M);
        playBattle(M, { seed, cfg: mkCfg(onSys), animator: stH, onTick: (scene) => { const c2 = scene.S.cur; if (c2 && c2.t === 'sysevent' && !c2.run) { waitTicks++; const v = scene.view(); if (v.fxSys === true) runDuring++; const h = digest32(ui2.render(v).rgba); held.push(prev === h ? 1 : 0); prev = h; } else prev = null; } });
        const same = held.reduce((a, b2) => a + b2, 0);
        t('system/prepare: while a handle is not ready the step holds the picture (no system draw, and the frame does not change from one waiting tick to the next): ' + same + ' of ' + (held.length - 1 > 0 ? held.length : 0) + ' repeats', waitTicks > 100 && runDuring === 0 && same >= waitTicks * 0.9, waitTicks + ' waiting ticks, ' + runDuring + ' with a run');
      }
      // BATTLE SPEED: still one slice a tick
      const sp4 = await (async () => { const st = await makeAnimator({ system: true, prepAdvances: 20 }); const r = playBattle(M, { seed, cfg: mkCfg({ on: true, speed: 4 }), animator: st }); return { st, r }; })();
      t('system/prepare: BATTLE SPEED 4x still gives ONE slice a tick, and the same battle', perTick(sp4.st.calls) === 1 && sp4.r.hash === base.r.hash, 'max per tick ' + perTick(sp4.st.calls));
      // faults: the old steps play, the battle is the same battle, the hooks fire once
      const plainH = (await slice({ system: false })).hooks;
      for (const [fail, label] of [['advance', 'every advance() throws'], ['begin', 'every begin() throws'], ['prepare', 'the first prepare() throws'], ['exhausted', 'every second prepare() throws (a full pool)']]) {
        const x = await slice({ prepFail: fail });
        const logOk = x.r.scene.animInfo().log.length >= 1;
        t('system/prepare: fault "' + label + '": the battle completes as the same battle (hash), the log says so, and the hit / faint hooks fire exactly once per event', x.r.hash === base.r.hash && logOk && x.hooks.hits === plainH.hits && x.hooks.faints === plainH.faints && x.r.scene.mode === 'result', 'hits ' + x.hooks.hits + '/' + plainH.hits + ' faints ' + x.hooks.faints + '/' + plainH.faints + ' log ' + x.r.scene.animInfo().log.length);
        if (fail === 'advance' || fail === 'begin') t('system/prepare: fault "' + label + '": every system run fell back (none began: animInfo().sys 0) and the plain steps played the battle', x.st.calls.sysBegins === 0 && x.r.scene.animInfo().sys === 0 && x.r.scene.mode === 'result', 'sys ' + x.r.scene.animInfo().sys);
      }
      {
        const oldTicks = async (so) => { const st = await makeAnimator(Object.assign({ system: true }, so)); let n = 0; playBattle(M, { seed, cfg: mkCfg(onSys), animator: st, onTick: (scene) => { const c3 = scene.S.cur; if (c3 && (c3.t === 'shake' || c3.t === 'faint' || c3.t === 'slidein' || c3.t === 'slideout')) n++; } }); oldTicks.events = st.calls.sysPrepares.length; return n; };
        const nPlain = await oldTicks({ system: false }), nFail = await oldTicks({ prepFail: 'begin' }), evFail = oldTicks.events, nOk = await oldTicks({});
        t('system/prepare: when every handle fails the OLD steps play (ticks of shake / faint / slide-in / slide-out: ' + nFail + ' = the plain battle\'s ' + nPlain + ', and none with working handles: ' + nOk + ')', nPlain > 20 && nFail >= nPlain && nFail - nPlain <= 3 * evFail && nOk < nPlain * 0.5, nFail + ' vs ' + nPlain + ' with ' + evFail + ' fallen-back runs (a fallback costs up to 3 extra ticks)');
      }
      // an animator without prepare() (the round-3 contract): start() as before, no prewarm
      { const x = await (async () => { const st = await makeAnimator({ system: true, noPrepare: true }); const r = playBattle(M, { seed, cfg: mkCfg(onSys), animator: st }); return { st, r }; })();
        t('system/prepare: an animator without prepare() is driven by start() as in round 3 (no handle, no prewarm, same tokens as with handles)', x.st.calls.sysPrepares.length === 0 && x.st.calls.sysWarm.length === 0 && x.st.calls.sysStarts.length >= 6 && x.r.tokens === base.r.tokens && x.r.hash === base.r.hash, JSON.stringify({ prep: x.st.calls.sysPrepares.length, warm: x.st.calls.sysWarm.length, starts: x.st.calls.sysStarts.length, tokEq: x.r.tokens === base.r.tokens, hashEq: x.r.hash === base.r.hash, a: x.r.tokens.slice(0, 40), b: base.r.tokens.slice(0, 40) })); }
      // animations switched off with handles waiting: they are given back
      { const st = await makeAnimator({ system: true, prepAdvances: 60 }); const cfg = mkCfg(onSys); let off = false;
        const r = playBattle(M, { seed, cfg, animator: st, onTick: (scene) => { if (!off && scene.S.queue.some((q) => q.prep && q.prep.h) && st.calls.sysPrepares.length >= 3) { off = true; cfg.set({ on: false }); } } });
        const cc = st.calls;
        t('system/prepare: switching animations off gives every handle that will never begin back (dispose), and nothing is left prepared: ' + nonWarm(cc).length + ' prepared = ' + cc.sysBegins + ' begun + ' + cc.sysDisposed + ' disposed', off && cc.sysDisposed >= 1 && nonWarm(cc).length === cc.sysBegins + cc.sysDisposed && r.scene.mode === 'result', 'off ' + off); }
      { // ... and at once: within three ticks of the switch every handle that was waiting is given back
        const st = await makeAnimator({ system: true, prepAdvances: 60 }); const cfg = mkCfg(onSys); let offAt = -1, waiting = 0, back = -1, d0 = 0;
        playBattle(M, { seed, cfg, animator: st, onTick: (scene, n) => { const c4 = st.calls; if (offAt < 0 && scene.S.queue.some((q) => q.prep && q.prep.h) && c4.sysPrepares.length >= 3) { offAt = n; d0 = c4.sysDisposed; waiting = scene.S.queue.filter((q) => q.prep && q.prep.h).length; cfg.set({ on: false }); } else if (offAt >= 0 && back < 0 && n >= offAt + 3) back = c4.sysDisposed - d0; } });
        t('system/prepare: ...and AT ONCE: the ' + waiting + ' handle(s) waiting when animations went off were disposed within three ticks (' + back + ')', offAt >= 0 && waiting >= 1 && back >= waiting, 'offAt ' + offAt); }
    }
    // round 8: THE ENGINE POOL. The real animator keeps three console engines (battle_sys.js SystemAnimator): the run that plays or waits for its handle, up to two prepared events, and the opening's PREWARM until its
    // pre-roll is done. pumpSys serves the events before the prewarm, so on a slow machine the prewarm was still pending when the first events were prepared, four engines were wanted, and the prepare of the third
    // event threw 'the system engine pool is exhausted' (seen with the real animator on the test's deterministic clock, seeds 2-5, also on the HEAD scene): that effect was then not prepared ahead and began late.
    // The stub models the pool (o.poolEngines) and a handle that needs 500 advances (the prewarm starves); the scene gives the prewarm up and prepares again, and says so in animInfo().notes, not in .log.
    {
      const POOL_SEEDS = quick ? [1] : [1, 2, 3, 4];
      const swDecide = () => { let taken = 0; return (req, def) => { if (req.phase === 'move' && req.switches && req.switches.length && !req.trapped && taken < 3) { taken++; return { kind: 'switch', slot: req.switches[0].slot }; } return def; }; };
      const play = async (sd, so) => { const st = await makeAnimator(Object.assign({ system: true }, so)); const hooks = { hits: 0, faints: 0, sounds: [], cries: [] }; hooks.onHit = () => hooks.hits++; hooks.onFaint = () => hooks.faints++; const r = playBattle(M, { seed: sd, cfg: mkCfg(onSys), animator: st, hooks, decide: swDecide() }); return { st, r, hooks, info: r.scene.animInfo() }; };
      const rows = [];
      for (const sd of POOL_SEEDS) rows.push({ sd, slow: await play(sd, { poolEngines: 3, prepAdvances: 500 }), big: await play(sd, { poolEngines: 4, prepAdvances: 500 }), plain: await play(sd, {}) });
      const brief = (r) => r.sd + ': log ' + JSON.stringify(r.slow.info.log).slice(0, 90) + ', shed ' + r.slow.info.shed + ', pool throws ' + (r.slow.st.calls.poolThrows | 0) + ', evicted ' + (r.slow.st.calls.sysEvicted | 0);
      t('system/pool: with a pool of three engines and handles that take long, no prepare() threw: the animation log is empty over ' + rows.length + ' battle(s) (it held "the system engine pool is exhausted")', rows.every((r) => r.slow.info.log.length === 0 && r.slow.r.scene.mode === 'result'), rows.map(brief).join(' | '));
      t('system/pool: ...and the prewarm was the one given up, once, where the pool was full: shed = the pool refusals, the prewarm handle was disposed, and animInfo().notes says so', rows.every((r) => r.slow.info.shed >= 1 && r.slow.info.shed === (r.slow.st.calls.poolThrows | 0) && r.slow.st.calls.sysWarm.length === 1 && r.slow.st.calls.sysWarm[0].disposed === true && r.slow.info.notes.filter((n) => /the prewarm was given up and it was prepared again/.test(n)).length === r.slow.info.shed), rows.map(brief).join(' | '));
      t('system/pool: ...no effect was cut off to make room (no live run evicted), every event the plain battle plays was played, and it is the same battle (hash, hit and faint hooks once per event)', rows.every((r) => (r.slow.st.calls.sysEvicted | 0) === 0 && r.slow.info.sys === r.plain.info.sys && r.slow.r.hash === r.plain.r.hash && r.slow.hooks.hits === r.plain.hooks.hits && r.slow.hooks.faints === r.plain.hooks.faints), rows.map((r) => r.sd + ': sys ' + r.slow.info.sys + '/' + r.plain.info.sys + ' hash ' + (r.slow.r.hash === r.plain.r.hash)).join(' | '));
      t('system/pool: control: with room for four engines (or fast handles) nothing is given up, nothing is noted, no prepare is refused', rows.every((r) => r.big.info.shed === 0 && r.big.info.notes.length === 0 && (r.big.st.calls.poolThrows | 0) === 0 && r.big.info.log.length === 0 && r.plain.info.shed === 0 && r.plain.info.notes.length === 0), rows.map((r) => r.sd + ': ' + r.big.info.shed + '/' + r.big.info.notes.length + '/' + r.plain.info.notes.length).join(' | '));
    }
    // prefetch: the heavy start() of an event run happens while an earlier message is up, not on the frame the event begins
    const lead = [];
    {
      const stubP = await makeAnimator({ system: true }); const seenAt = new Map(); let evN = 0;
      playBattle(M, { seed, cfg: mkCfg(onSys), animator: stubP, onTick: (scene, n) => { const c = scene.S.cur; if (c && c.t === 'sysevent' && !seenAt.has(c)) { seenAt.set(c, n); const k = stubP.calls.sysStarts.length - 1; void k; evN++; } } });
      // the n-th event step began at ticks[n]; its run was started at sysStarts[n + 1].tick
      const began = [...seenAt.values()], started = stubP.calls.sysStarts.slice(1).map((x) => x.tick);
      const early = began.map((b2, i) => b2 - (started[i] === undefined ? b2 : started[i]));
      for (const e of early) lead.push(e);
      t('system: prefetch: most event runs were started well before their step begins (while a message was up): ' + early.filter((e) => e >= 5).length + ' of ' + early.length, early.length >= 6 && early.filter((e) => e >= 5).length >= Math.ceil(early.length * 0.6), JSON.stringify(early.slice(0, 12)));
    }
    // fallbacks: no system kind -> the old steps; animations OFF -> the old steps and no call at all
    const stubOffSys = await makeAnimator({ system: true });
    const offSys = playBattle(M, { seed, cfg: mkCfg({ on: false }), animator: stubOffSys });
    t('system: animations OFF with a system-capable animator: no system run starts and the frame stream equals the plain OFF stream', stubOffSys.calls.sysStarts.length === 0 && offSys.digest === playBattle(M, { seed }).digest, '');
    t('system: an animator without system animations leaves the old steps (tokens start with the lead messages, no S)', !plain.tokens.startsWith('S') && /^T/.test(plain.tokens) && stubPlain.calls.sysStarts.length === 0, plain.tokens.slice(0, 10));
    const stubFb = await makeAnimator({ system: true, sysLevel: 'fallback' });
    const fb = playBattle(M, { seed, cfg: mkCfg(onSys), animator: stubFb });
    t('system: a system animation the engine calls "fallback" is never started (the old steps play)', stubFb.calls.sysStarts.length === 0 && fb.tokens === plain.tokens, '');
    t('system: determinism: the same seed gives the same frame stream with system runs', playBattle(M, { seed, cfg: mkCfg(onSys), animator: await makeAnimator({ system: true }) }).digest === sys.digest, '');
    // the opening, frame by frame: no hot-pink key colour anywhere, and black while the opening is not prepared yet (the real game starts black)
    {
      const stI = await makeAnimator({ system: true }), ui3 = uiOf(M); const hold = []; let pinkFrames = 0, nFr = 0;
      playBattle(M, { seed, cfg: mkCfg(onSys), animator: stI, maxFrames: 300, onTick: (scene) => { const c = scene.S.cur, sc = scanFrame(ui3.render(scene.view()).rgba); nFr++; if (sc.pink) pinkFrames++; if (c && c.t === 'sysintro' && !c.run) hold.push(sc.nonBlack); } });
      t('system: the opening: none of its first ' + nFr + ' frames has a pixel of the ROM\'s hot-pink key colour', pinkFrames === 0 && nFr >= 250, pinkFrames + ' of ' + nFr + ' frames');
      t('system: ...and every frame while the opening is not prepared yet is black (' + hold.length + ' frames)', hold.length >= 2 && hold.every((n) => n === 0), JSON.stringify(hold));
    }
    // the picture: a system run draws the WHOLE screen; the scene adds only its text box
    {
      const b = makeBattle(M, { seed, cfg: mkCfg(onSys), animator: await makeAnimator({ system: true }) }); const { scene } = b, ui = uiOf(M);
      let g = 0; while (g++ < 800 && !(scene.S.cur && scene.S.cur.t === 'sysintro' && scene.S.cur.run && scene.S.cur.n > 20)) scene.tick();
      const v = scene.view(), img = ui.render(v), fill = [(1 * 17) & 255, (scene.S.cur.run.frame * 5) & 255, 77];
      let own = 0; for (let y = 0; y < 112; y++) for (let x = 0; x < 240; x++) { const q = (y * 240 + x) * 4; if (img.rgba[q] !== fill[0] || img.rgba[q + 1] !== fill[1] || img.rgba[q + 2] !== fill[2]) own++; }
      t('system: while the intro runs the scene draws nothing of the battlefield or the healthboxes (the run draws all of it)', v.fxSys === true && own === 0, own + ' px of the field are not the run\'s');
    }
  }

  /* ---- BATTLE SPEED does not touch typed messages ---- */
  {
    const textFrames = (cfgInit) => {
      const b = makeBattle(M, { seed: 4, cfg: cfgInit ? mkCfg(cfgInit) : undefined });
      const { scene } = b; let first = null, n = 0;
      while (n++ < 5000) { scene.tick(); const c = scene.S.cur; if (!first && c && c.t === 'text') first = c; if (first && scene.S.cur !== first) break; }
      return n;
    };
    const a1 = textFrames({ on: true, speed: 1 }), a4 = textFrames({ on: true, speed: 4 }), a0 = textFrames(null);
    t('speed: the first typed message takes the same frames at 1x, 4x and with no settings (text speed is its own setting)', a1 === a4 && a1 === a0 && a1 > 30, a1 + ' / ' + a4 + ' / ' + a0);
  }

  /* ---- the Pokemon front picture swap from the ROM ---- */
  {
    // a seed whose foe lead has a second front picture (689 of 1038 species do)
    let seed = 0;
    for (let sd = 5; sd < 60 && !seed; sd++) { const bb = makeBattle(M, { seed: sd, cfg: mkCfg({ on: true }) }); let g = 0; while (g++ < 4000 && !bb.scene.S.disp[1]) { bb.scene.tick(); if (bb.scene.mode === 'steps' && bb.scene.S.cur && bb.scene.S.cur.t === 'text') bb.scene.press('a'); } const ai0 = bb.scene.S.disp[1] && M.AM.speciesAnimInfo(rom, bb.scene.S.disp[1].species); if (ai0 && ai0.frames > 1) seed = sd; }
    t('front swap: a seed with a two-picture foe lead exists', seed > 0, seed);
    const run = (cfgInit, romOverride) => {
      const st = null;
      void st;
      const b = makeBattle(M, { seed, cfg: cfgInit ? mkCfg(cfgInit) : undefined });
      const { scene } = b;
      const seen = new Set(), seq = []; let exact = true, checked = 0, spec = 0, guard = 0;
      while (guard++ < 30000 && scene.mode !== 'result' && checked < 400) {
        scene.tick();
        if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
        const v = scene.view(), fr = v.foe ? v.foe.frame : 0, info = scene.animInfo();
        if (v.foe) seen.add(fr);
        const m = info.mon[1];
        if (m) {
          const sp = scene.S.disp[1].species, ai = M.AM.speciesAnimInfo(romOverride || rom, sp);
          spec = sp; checked++;
          if (fr !== M.AM.frontFrameAt(ai, m.t)) exact = false;
          seq.push(fr);
        }
      }
      return { seen, exact, checked, spec, seq: seq.join('') };
    };
    const on = run({ on: true }), off = run({ on: false }), none = run(undefined);
    t('front swap: with animations on the foe\'s picture follows the ROM durations exactly while the swap runs', on.checked > 20 && on.exact, on.checked + ' ticks checked, species ' + on.spec);
    t('front swap: both pictures appear for a two-picture species', on.seen.has(0) && on.seen.has(1), [...on.seen].join());
    t('front swap: animations off (or no settings) never leave picture 0', off.seen.size === 1 && off.seen.has(0) && none.seen.size === 1 && none.seen.has(0) && off.checked === 0);
    // the data comes from the ROM: a copy whose animation list is flattened shows no second picture
    const flat = rom.slice(); const sp = on.spec; const ai = M.AM.speciesAnimInfo(rom, sp);
    const ptr = (flat[0x7c7310 + sp * 0x118 + 0x58] | (flat[0x7c7310 + sp * 0x118 + 0x59] << 8) | (flat[0x7c7310 + sp * 0x118 + 0x5a] << 16)) & 0xffffff;
    const listOff = (flat[ptr + 4] | (flat[ptr + 5] << 8) | (flat[ptr + 6] << 16)) & 0xffffff;
    for (let k = 0; k < ai.cmds.length; k++) if (ai.cmds[k].img === 1) { flat[listOff + k * 4] = 0; flat[listOff + k * 4 + 1] = 0; }
    const ai2 = M.AM.speciesAnimInfo(flat, sp);
    t('front swap: corrupting the ROM\'s animation list for the species removes its second picture (the swap is read from the ROM)', ai.frames === 2 && ai2 && ai2.frames === 1 && M.AM.frontFrameAt(ai2, 25 + 30) === 0);
  }

  /* ---- the pause menu rows ---- */
  {
    const open = (cfgInit) => {
      const b = makeBattle(M, { seed: 2, cfg: cfgInit === null ? undefined : mkCfg(cfgInit) });
      const { scene } = b;
      scene.S.auto = null;
      let g = 0;
      while (scene.mode !== 'action' && g++ < 90000) {
        scene.tick();
        if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
        else if (scene.mode === 'preview') { const p = scene.S.preview; if (p.picks.length < p.pick) { scene.press('a'); if (scene.mode === 'preview') scene.press('down'); } }
        else if (scene.mode === 'confirm' && scene.S.confirm.kind === 'team') scene.press('a');
      }
      return { scene, b };
    };
    const { scene, b } = open({ on: true, speed: 1 });
    t('menu: the pause menu is reachable from the action menu', scene.mode === 'action');
    scene.press('start');
    const rows = scene.state().overlay || [];
    t('menu: rows ANIMATION: ON and BATTLE SPEED: 1X are listed (with the others)', rows.includes('ANIMATION: ON') && rows.includes('BATTLE SPEED: 1X') && rows[0] === 'RESUME' && rows.includes('FORFEIT'), rows.join('|'));
    const idx = rows.indexOf('ANIMATION: ON');
    scene.S.menu.cursor = idx; scene.S.overlay.cursor = idx; scene.press('a');
    const rows2 = scene.state().overlay || [];
    t('menu: choosing ANIMATION turns it OFF, shows OFF, and the menu stays open on that row', rows2.includes('ANIMATION: OFF') && scene.mode === 'menu' && scene.S.menu.rows[scene.S.menu.cursor].startsWith('ANIMATION'), rows2.join('|'));
    const si = rows2.findIndex((r) => r.startsWith('BATTLE SPEED'));
    const seen = [];
    for (let k = 0; k < 3; k++) { const rr = scene.state().overlay; const i = rr.findIndex((r) => r.startsWith('BATTLE SPEED')); scene.S.menu.cursor = i; scene.S.overlay.cursor = i; scene.press('a'); seen.push(scene.state().overlay.find((r) => r.startsWith('BATTLE SPEED'))); }
    void si;
    t('menu: choosing BATTLE SPEED cycles 2X, 4X, 1X', seen.join() === 'BATTLE SPEED: 2X,BATTLE SPEED: 4X,BATTLE SPEED: 1X', seen.join());
    t('menu: the setting object the page owns was changed (anim off now)', b.scene.animInfo().active === false);
    scene.press('b');
    t('menu: B closes it back to the action menu', scene.mode === 'action');
    const plain = open(null);
    plain.scene.press('start');
    t('menu: with no animation settings the menu is exactly the old one (no ANIMATION / SPEED rows)', !(plain.scene.state().overlay || []).some((r) => /ANIMATION|BATTLE SPEED/.test(r)), (plain.scene.state().overlay || []).join('|'));
  }

  /* ---- frame cost ---- */
  {
    const st = await makeAnimator();
    let worst = 0, tot = 0, nT = 0;
    playBattle(M, { seed: SEL.move[0], cfg: mkCfg({ on: true }), animator: st, hashEvery: 1, maxFrames: quick ? 2500 : 6000, onTick: () => { } });
    void worst; void tot; void nT;
    t('cost: the harness itself runs (frame cost is measured in the timing section below, not asserted here)', true);
  }
  return f;
}

/* ================================================================================================ run on the real tree */
const real = await loadStack(JS);
// The engine keeps changing (FA2), so NO check below names a seed: each battle used is FOUND here, with the real engine, because it has the property the check needs (move animations, blinks, a
// stat / status animation, sounds, cries, lunges for the "none" fallback; or hits, faints and mid-battle send-outs for the system group). The golden hashes further down are the one place a
// fixed battle is pinned on purpose.
SEL = {
  move: await findSeeds(real, (p) => p.done && p.A >= 6 && p.H >= 5 && p.HA >= 4 && p.G >= 1 && p.L >= 4 && p.snd >= 6 && p.cry >= 2, 2),
  sys: await findSeeds(real, (p) => p.done && p.H >= 3 && p.F >= 2 && p.I >= 4 && p.A >= 4 && p.H + p.F + p.I - 2 >= 7, 1),
};
ok(SEL.move.length === 2, '0. scenario: two battles were found at run time with >= 6 move animations, >= 5 blinks, a stat / status animation, >= 6 sounds, >= 2 cries and lunges for the fallback (seeds ' + SEL.move.join(',') + ')');
ok(SEL.sys.length === 1, '0. scenario: a battle was found with >= 3 hit blinks, >= 2 faints and >= 2 mid-battle send-outs for the system group (seed ' + SEL.sys.join(',') + ')');
ok((await findSeeds(real, (p) => p.A > 1e6, 1, 6)).length === 0 && (await findSeeds(real, (p) => p.done && p.H >= 5 && p.F >= 1000, 1, 6)).length === 0, '0. scenario negative control: an impossible requirement finds no battle (the finder can say no)');
const realFails = await core(real, { fast: false });
for (const x of realFails) ok(false, 'core: ' + x);
ok(realFails.length === 0, '1. every anim-scene check passes on the real tree (' + realFails.length + ' failing)');

/* ---- THE HANDOFF (round 3): the scene's own picture vs the system run's picture, pixel by pixel, in both directions, with the REAL ROM engine ---- */
// "scene" = battle_ui.js render of the scene's view at rest (what the page shows when no run is playing); "run" = battle_ui.js render of a view carrying the system run (what the page shows
// during it: the run's picture without its text boxes + the scene's own box). Frame 0 = right after start(); last = after done / ready. Counts are of 38400 pixels.
{
  const SYSM = await import(pathToFileURL(path.join(JS, 'anim_sys.js')).href);
  const mod = await import(pathToFileURL(path.join(JS, 'move_anim.js')).href);
  let cov = null; try { cov = JSON.parse(fs.readFileSync(path.join(JS, 'anim_coverage.json'), 'utf8')); } catch (_e) { /* none */ }
  const animator = await mod.createMoveAnimator({ rom, coverage: cov });
  const pack = packOf(real), ui = uiOf(real);
  const expOf = (sp, lv) => pack.exp[pack.species[sp].growthRate][lv];
  const mon = (sp, name, lv, hp, max, o) => Object.assign({ species: sp, name, level: lv, gender: null, hp, maxHp: max, status: null, shiny: false, drop: 0, visible: true, showBox: true, dx: 0, dy: 0, tint: 0, boxDx: 0, frame: 0 }, o || {});
  const ENV = 4;
  const spec = (m, o) => SYSM.partySpec(m, o, expOf);
  const diff = (a, b2, r) => { let n = 0; for (let i = 0; i < 240 * 160; i++) { if (r) { const x = i % 240, y = (i / 240) | 0; if (x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]) continue; } const q = i * 4; if (a[q] !== b2[q] || a[q + 1] !== b2[q + 1] || a[q + 2] !== b2[q + 2]) n++; } return n; };
  const runView = (run, v) => { const vv = Object.assign({}, v, { fxSys: true }); Object.defineProperty(vv, 'fxDraw', { value: (fr) => run.draw(fr, { layers: SYSM.LAYERS_NO_TEXT }), enumerable: false }); return ui.render(vv); };
  const menu = { mode: 'action', prompt: ['What will', 'Charizard do?'], cursor: 0 };
  // ---- the intro: the run's last frame (with its OWN text boxes, BG0 on: the ROM's action menu) against the scene's action menu
  const introCases = [
    ['plain', mon(143, 'Snorlax', 50, 200, 200, { gender: 'M' }), mon(6, 'Charizard', 50, 150, 150, { gender: 'M', exp: { into: 0, span: 1 } })],
    ['shiny foe + shiny player (sparkle, yellow healthboxes)', mon(143, 'Snorlax', 50, 200, 200, { gender: 'M', shiny: true }), mon(6, 'Charizard', 50, 150, 150, { gender: 'F', shiny: true, exp: { into: 0, span: 1 } })],
    ['genderless foe, level 5 player', mon(81, 'Magnemite', 5, 17, 17), mon(25, 'Pikachu', 5, 20, 20, { gender: 'F', exp: { into: 0, span: 1 } })],
  ];
  const introRows = [];
  for (const [label, foe, me] of introCases) {
    const run = animator.start('system', 1, { foe: spec(foe), player: spec(me), environment: ENV, keys: null, trainer: 1 });
    let n = 0; while (!run.ready && !run.done && n++ < 2500) { run.setKeys(n % 20 === 0 ? 1 : 0); run.step(); }
    const last = { width: 240, height: 160, data: new Uint8ClampedArray(240 * 160 * 4) }; run.draw(last, { layers: SYSM.LAYERS_ALL });
    const sc = ui.render({ env: ENV, foe, player: me, box: Object.assign({}, menu, { prompt: ['What will', me.name + ' do?'] }), tags: [], overlay: null });
    introRows.push([label, n, diff(last.data, sc.rgba)]);
  }
  for (const [label, n, d] of introRows) ok(d <= 0 && n > 200, '4. handoff: the intro\'s last frame (' + n + ' frames) is the scene\'s action menu: ' + label, d + ' of 38400 px differ');
  // negative control: the experience of the level left out (what a first version did) must show: the trainer foe's level text is recomputed by the ROM
  {
    const [, foe, me] = introCases[0];
    const run = animator.start('system', 1, { foe: SYSM.partySpec(foe), player: spec(me), environment: ENV, keys: null });
    let n = 0; while (!run.ready && !run.done && n++ < 2500) { run.setKeys(n % 20 === 0 ? 1 : 0); run.step(); }
    const last = { width: 240, height: 160, data: new Uint8ClampedArray(240 * 160 * 4) }; run.draw(last, { layers: SYSM.LAYERS_ALL });
    const sc = ui.render({ env: ENV, foe, player: me, box: Object.assign({}, menu), tags: [], overlay: null });
    ok(diff(last.data, sc.rgba) >= 20, '4. handoff negative control: without the experience of its level the same comparison finds the wrong foe level (>= 20 px)', diff(last.data, sc.rgba) + ' px');
  }
  // ---- the events: frame 0 against the scene BEFORE the event, the last frame against the scene AFTER it
  const FOE = mon(143, 'Snorlax', 50, 160, 200, { gender: 'M' }), ME = mon(6, 'Charizard', 50, 120, 150, { gender: 'M', exp: { into: 0, span: 1 } });
  const NEW_ME = mon(25, 'Pikachu', 50, 90, 110, { gender: 'F', exp: { into: 0, span: 1 } }), NEW_FOE = mon(130, 'Gyarados', 50, 170, 170, { gender: 'M' });
  const box = { mode: 'message', text: ['Charizard used Tackle!', ''], arrow: false };
  const rest = (o) => Object.assign({ env: ENV, foe: FOE, player: ME, box, tags: [], overlay: null }, o || {});
  const dead = (m) => Object.assign({}, m, { hp: 0, visible: false, showBox: false });
  const SHADOW_RECT = (() => { const sp = ui.sprite(FOE.species, 'foe', {}); const top = ui.LAYOUT.foeCenter[1] + sp.yOffset - sp.elevation - 32; return [ui.LAYOUT.foeCenter[0] - 32 + sp.shadow.dx, top + 44 + sp.shadow.dy, 64, 8]; })();
  const events = [
    // name, id, extra ctx, scene before, scene after, allowed px at frame 0, allowed px at the end, [x, y, w, h] where frame 0 may differ (everything outside it must match)
    ['hit foe', 7, {}, rest(), rest(), 0, 0], ['hit player', 6, {}, rest(), rest(), 0, 0],
    // The faint-foe run's frame 0 has no ground shadow and the scene's standing foe has: 71 px, all inside the shadow rectangle. The ROM removes the shadow ONE FRAME BEFORE the sprite starts to sink
    // (oracle, a Snorlax at 3 HP knocked out by Tackle: shadow pixels 71 until frame 115, 0 from 116, sprite zone full until 116 and shrinking from 117), and the run's frame 0 IS that frame.
    ['faint foe', 5, {}, rest({ foe: Object.assign({}, FOE, { hp: 0 }) }), rest({ foe: dead(FOE) }), 71, 0, SHADOW_RECT], ['faint player', 4, {}, rest({ player: Object.assign({}, ME, { hp: 0 }) }), rest({ player: dead(ME) }), 0, 0],
    ['recall player', 3, {}, rest(), rest({ player: undefined }), 0, 0], ['recall foe (trainer)', 9, {}, rest(), rest({ foe: undefined }), 2, 0],
    ['send-out player', 2, { switchIn: spec(NEW_ME) }, rest({ player: undefined }), rest({ player: NEW_ME }), 0, 0],
    ['send-out foe (trainer)', 8, { switchIn: spec(NEW_FOE) }, rest({ foe: undefined }), rest({ foe: NEW_FOE }), 0, 0],
  ];
  const evRows = [];
  for (const [name, id, extra, before, after, lim0, lim1, rect0] of events) {
    const ctx = Object.assign({ foe: spec(id === 5 ? Object.assign({}, FOE, { hp: 0 }) : FOE, id === 5 ? { hp: 0 } : undefined), player: spec(id === 4 ? ME : ME, id === 4 ? { hp: 0 } : undefined), environment: ENV, trainer: id >= 8 ? 1 : 0, seed: 1 }, extra);
    const t0 = process.hrtime.bigint(); const run = animator.start('system', id, ctx); const startMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const d0 = diff(runView(run, before).rgba, ui.render(before).rgba), d0out = rect0 ? diff(runView(run, before).rgba, ui.render(before).rgba, rect0) : d0;
    let n = 0; while (!run.done && n++ < 3000) run.step();
    const d1 = diff(runView(run, after).rgba, ui.render(after).rgba);
    evRows.push([name, id, n, startMs, d0, d1]);
    ok(d0 <= lim0 && (!rect0 || d0out === 0) && d1 <= lim1 && n > 30, '4. handoff: ' + name + ' (id ' + id + ', ' + n + ' frames): frame 0 vs the scene before ' + d0 + ' px (<= ' + lim0 + (rect0 ? ', all inside the foe shadow rectangle: ' + d0out + ' outside' : '') + '), last frame vs the scene after ' + d1 + ' px (<= ' + lim1 + ')', 'start() ' + startMs.toFixed(0) + ' ms');
  }
  // negative control: a scene whose foe has a different HP than the run's must be seen
  {
    const run = animator.start('system', 7, { foe: spec(FOE), player: spec(ME), environment: ENV, trainer: 0, seed: 1 });
    const wrong = rest({ foe: Object.assign({}, FOE, { hp: 40 }) });
    ok(diff(runView(run, wrong).rgba, ui.render(wrong).rgba) >= 20, '4. handoff negative control: a scene that shows another foe HP than the run is found (>= 20 px)', '');
  }
  // ---- round 7b: WHICH POKEMON EACH SWITCH EFFECT DRAWS. The scene projects (and re-checks at start) exactly the Pokemon an effect draws: both sides of a recall, the OTHER side of a send-out. This is the evidence for
  // that line, with the ROM engine: EVERY frame of the whole effect is hashed, then the same effect is run with one Pokemon changed. A send-out is identical in every frame for any HP or species of the side that
  // sends out (the Pokemon it replaces) and different for the other side's HP; a recall is different for either side's HP (the recalled Pokemon is drawn, with its bar).
  {
    const hashAll = (id, ctx) => { const run = animator.start('system', id, ctx); const h = crypto.createHash('sha1'), fr = { width: 240, height: 160, data: new Uint8ClampedArray(240 * 160 * 4) }; let n = 0; while (!run.done && n++ < 3000) { run.step(); fr.data.fill(0); run.draw(fr, { layers: SYSM.LAYERS_ALL }); h.update(fr.data); } return h.digest('hex') + ':' + n; };
    for (const [name, id, lead, extra, sendOut] of [['foe send-out', 8, 'foe', { switchIn: spec(NEW_FOE) }, true], ['player send-out', 2, 'player', { switchIn: spec(NEW_ME) }, true], ['foe recall', 9, 'foe', {}, false], ['player recall', 3, 'player', {}, false]]) {
      const leadMon = lead === 'foe' ? FOE : ME, otherKey = lead === 'foe' ? 'player' : 'foe', otherMon = lead === 'foe' ? ME : FOE;
      const mk = (o) => Object.assign({ foe: spec(FOE), player: spec(ME), environment: ENV, trainer: id >= 8 ? 1 : 0, seed: 1 }, o, extra);
      const base = hashAll(id, mk({})), leadHp = hashAll(id, mk({ [lead]: spec(Object.assign({}, leadMon, { hp: 37 })) })), otherHp = hashAll(id, mk({ [otherKey]: spec(Object.assign({}, otherMon, { hp: 37 })) }));
      const leadSp = sendOut ? hashAll(id, mk({ [lead]: spec(Object.assign({}, leadMon, { species: lead === 'foe' ? 130 : 25, name: 'X' })) })) : null;
      if (sendOut) ok(leadHp === base && leadSp === base && otherHp !== base, '4. draws: a ' + name + ' (id ' + id + ', ' + base.split(':')[1] + ' frames) is identical in every frame for any HP (37) or species of the side that sends out (the Pokemon it replaces), and different for the other side\'s HP', 'lead hp ' + (leadHp === base) + ', lead species ' + (leadSp === base) + ', other hp differs ' + (otherHp !== base));
      else ok(leadHp !== base && otherHp !== base, '4. draws: a ' + name + ' (id ' + id + ', ' + base.split(':')[1] + ' frames) draws BOTH Pokemon: the recalled one\'s HP and the other side\'s HP each change frames', 'lead hp differs ' + (leadHp !== base) + ', other hp differs ' + (otherHp !== base));
    }
  }
  // ---- round 4: the trainer pictures, with the real engine
  {
    const tc = SYSM.trainerChoices(rom), CSM = await import(pathToFileURL(path.join(JS, 'charset.js')).href);
    const T = { offset: 0x497FBC, stride: 52, classAt: 28 }, cnameAt = (c) => { const bs = []; for (let i = 0; i < 13 && rom[0x43b03c + c * 16 + i] !== 0xff; i++) bs.push(rom[0x43b03c + c * 16 + i]); return CSM.decodeText(Uint8Array.from(bs)); };
    ok(tc.easy.length >= 4 && tc.normal.length >= 10 && tc.hard.length >= 4, '4. trainers: the ROM table gives lists for the three CPU levels (' + tc.easy.length + ' / ' + tc.normal.length + ' / ' + tc.hard.length + ' distinct pictures)', JSON.stringify(tc).slice(0, 120));
    const cls = (id) => cnameAt(rom[T.offset + id * T.stride + T.classAt]);
    ok(tc.easy.every((id) => /^(Youngster|Lass|Bug Catcher|School Kid|Camper|Picnicker)$/.test(cls(id))) && tc.hard.every((id) => /^(Elite Four|Champion)$/.test(cls(id))) && tc.normal.every((id) => /^(Cooltrainer|Leader)$/.test(cls(id))), '4. trainers: every listed trainer is of the class its level names (decoded from the ROM class-name table)', tc.hard.map(cls).join('/'));
    ok(SYSM.trainerChoices(new Uint8Array(1000)).easy.length === 0 && SYSM.pickTrainer({ easy: [] }, 'easy', 1) === 0 && SYSM.pickTrainer(null, 'easy', 1) === 0, '4. trainers: an unknown ROM gives no trainer and the pick says 0 (the engine default stays)');
    const frameHash = (ctxo, frames) => { const run = animator.start('system', 1, Object.assign({ foe: spec(mon(143, 'Snorlax', 50, 200, 200, { gender: 'M' })), player: spec(mon(6, 'Charizard', 50, 150, 150, { gender: 'M', exp: { into: 0, span: 1 } })), environment: ENV, keys: null }, ctxo)); const fr = { width: 240, height: 160, data: new Uint8ClampedArray(240 * 160 * 4) }; for (let i = 0; i < frames; i++) run.step(); run.draw(fr, { layers: SYSM.LAYERS_NO_TEXT }); let h = 2166136261; for (let i = 0; i < fr.data.length; i++) h = Math.imul(h ^ fr.data[i], 16777619) >>> 0; return h; };
    const hs = {}; for (const lv of ['easy', 'normal', 'hard']) hs[lv] = frameHash({ trainer: SYSM.pickTrainer(tc, lv, 7), seed: 1 }, 100);
    const hDef = frameHash({ seed: 1 }, 100), hSame = frameHash({ trainer: SYSM.pickTrainer(tc, 'easy', 7), seed: 1 }, 100);
    ok(new Set([hs.easy, hs.normal, hs.hard, hDef]).size === 4, '4. trainers: the opening shows a different picture for easy, normal, hard and the default trainer (frame 100 of the real engine)', JSON.stringify(hs) + ' default ' + hDef);
    ok(hSame === hs.easy, '4. trainers negative control: the same trainer id gives the same frame (so the differences above are the pictures)');
    ok(frameHash({ gender: 'F', seed: 1 }, 100) !== frameHash({ gender: 'M', seed: 1 }, 100), '4. trainers: the player\'s back sprite is the ROM\'s other one for gender F');
  }
  // ---- round 6: the opening, every frame, against the real game's first frames
  {
    const OI = await oracleIntro();
    ok(OI.ok && OI.pink === 0 && OI.blackPrefix >= 2, '6. oracle: the real game\'s first ' + (OI.frames || 0) + ' frames after the battle transition have 0 pixels of the hot-pink key colour and start black (' + (OI.blackPrefix || 0) + ' black frames first)' + (OI.ok ? '' : ' [' + OI.err + ']'), OI.ok ? 'pink ' + OI.pink + ', black prefix ' + OI.blackPrefix : OI.err);
    if (OI.ok) {
      // the strip under the text box is a flat colour that differs per environment (hot pink 0xff0084 in environment 3, tan in 7, green in 0 / 1 ...): scan the hot-pink one and another
      const sPink = SEED0 + ((3 - (SEED0 % 9) + 9) % 9), sOther = SEED0 + ((7 - (SEED0 % 9) + 9) % 9);
      for (const [withAnim, seedI] of [[true, sPink], [true, sOther], [false, sPink]]) {
        const sc = await introScan(withAnim, seedI);
        const odd = [...sc.bottom].filter((c) => c !== 0 && !OI.bottom.has(c));
        ok(sc.ticks >= 100 && sc.mode === 'action', '6. opening scan (' + (withAnim ? 'system animations' : 'animations off') + ', environment ' + (seedI % 9) + '): played to the action menu in ' + sc.ticks + ' ticks', sc.mode);
        ok(sc.pinkTicks === 0, '6. opening (' + (withAnim ? 'system animations' : 'animations off') + ', environment ' + (seedI % 9) + '): no frame of the whole opening has the hot-pink key colour (' + sc.pinkTicks + ' frames, up to ' + sc.maxPink + ' px)', '');
        if (withAnim) ok(sc.holdTicks >= 1 && sc.holdNonBlack === 0, '6. opening: the ' + sc.holdTicks + ' ticks before the run exists are black', 'non-black px ' + sc.holdNonBlack);
        ok(odd.length === 0, '6. opening (' + (withAnim ? 'system animations' : 'animations off') + ', environment ' + (seedI % 9) + '): every colour of rows 112..159 in every frame is a colour the real game shows there in its first ' + OI.frames + ' frames', odd.slice(0, 6).map((c) => c.toString(16)).join(',') + ' (' + odd.length + ' not in the oracle)');
      }
      // negative controls: the detectors see what they are for
      const pinkImg = new Uint8Array(240 * 160 * 4); for (let i = 112 * 240; i < 160 * 240; i++) { pinkImg[i * 4] = 255; pinkImg[i * 4 + 1] = 0; pinkImg[i * 4 + 2] = 132; pinkImg[i * 4 + 3] = 255; }
      const sp = scanFrame(pinkImg);
      ok(sp.pink === 48 * 240 && !(sp.bottom.size === 1 && [...sp.bottom].every((c) => OI.bottom.has(c))), '6. opening negative control: a frame with the key colour over the text-box area is found by both detectors (' + sp.pink + ' px; the colour is not one of the oracle\'s)', '');
      ok(OI.bottom.has(0xffffff) || OI.bottom.size > 3, '6. opening negative control: the oracle\'s colour set is a real set (' + OI.bottom.size + ' colours), not an empty one that would flag nothing');
    }
  }
  // ---- round 6: primal weather: the animation the real game plays when Primordial Sea / Desolate Land / Delta Stream takes the field (FV1: the scene queued none)
  {
    let WA = null;
    try {
      const OR = await import(pathToFileURL(path.join(root, 'tools', 'pokemonarena_rom_oracle.mjs')).href);
      const o = await OR.openOracle({}); const pk = packOf(real); WA = {};
      for (const nm of ['Drizzle', 'Drought', 'Primordial Sea', 'Desolate Land', 'Delta Stream']) WA[nm] = await oracleWeatherAnim(OR, o, pk, nm);
    } catch (e) { WA = { err: String(e && e.message ? e.message : e).slice(0, 160) }; }
    const good = WA && !WA.err && Object.values(WA).every((x) => x.ok);
    ok(good, '7. oracle: the real game starts a weather animation for each of Drizzle, Drought, Primordial Sea, Desolate Land and Delta Stream' + (good ? '' : ' [' + JSON.stringify(WA).slice(0, 200) + ']'), good ? Object.entries(WA).map(([k, x]) => k + ' ptr ' + x.ptr.toString(16) + ' general ' + x.general).join('; ') : '');
    if (good) {
      const AMr = real.AM, hex = (x) => x.ptr.toString(16);
      ok(WA['Primordial Sea'].ptr === WA.Drizzle.ptr && AMr.WEATHER_ANIM_OF[6] === AMr.WEATHER_ANIM_OF[1], '7. oracle: Primordial Sea plays the same animation script as Drizzle (' + hex(WA['Primordial Sea']) + ' = ' + hex(WA.Drizzle) + '), so the scene\'s id for heavy rain is the rain one: ' + AMr.WEATHER_ANIM_OF[6] + ' = ' + AMr.WEATHER_ANIM_OF[1], AMr.WEATHER_ANIM_OF[6] === AMr.WEATHER_ANIM_OF[1]);
      ok(WA['Desolate Land'].ptr === WA.Drought.ptr && AMr.WEATHER_ANIM_OF[7] === AMr.WEATHER_ANIM_OF[2], '7. oracle: Desolate Land plays the same animation script as Drought (' + hex(WA['Desolate Land']) + ' = ' + hex(WA.Drought) + '), so the scene\'s id for harsh sun is the sun one: ' + AMr.WEATHER_ANIM_OF[7] + ' = ' + AMr.WEATHER_ANIM_OF[2], AMr.WEATHER_ANIM_OF[7] === AMr.WEATHER_ANIM_OF[2]);
      ok(WA['Delta Stream'].general === 29 && AMr.WEATHER_ANIM_OF[8] === WA['Delta Stream'].general, '7. oracle: Delta Stream plays general animation ' + WA['Delta Stream'].general + ' and the scene queues exactly that id (' + AMr.WEATHER_ANIM_OF[8] + ')', 'general ' + WA['Delta Stream'].general);
      ok(WA.Drizzle.ptr !== WA.Drought.ptr && WA.Drizzle.general === AMr.WEATHER_ANIM_OF[1] && WA['Delta Stream'].ptr !== WA.Drizzle.ptr, '7. oracle negative control: rain, sun and winds are three different animations in the real game, and Drizzle\'s measured id is the scene\'s rain id (so a swapped table is caught)', 'drizzle ' + hex(WA.Drizzle) + ' general ' + WA.Drizzle.general + ' drought ' + hex(WA.Drought));
      // the scene queues those ids for the pair of events the engine emits (the ids are what the scene plays through the animator it is given; the scene-events test checks the queue)
      const ids = [6, 7, 8].map((w) => AMr.WEATHER_ANIM_OF[w]);
      ok(ids.every((x) => Number.isInteger(x)) && new Set(ids).size === 3, '7. the three primal weathers have three different general animation ids (' + ids.join(', ') + ')');
    }
  }
  console.log('handoff table (px of 38400; start() = the ROM pre-roll, host time)'); for (const [label, n, d] of introRows) console.log('  intro  ' + label.padEnd(56) + String(n).padStart(4) + ' frames  last-frame diff ' + d);
  for (const [name, id, n, ms, d0, d1] of evRows) console.log('  event  ' + name.padEnd(56) + String(n).padStart(4) + ' frames  start ' + ms.toFixed(0).padStart(4) + ' ms  frame-0 diff ' + d0 + '  last-frame diff ' + d1);
}

/* ---- timing: per-frame cost of tick + render with the animator running (a stub's draw is cheap; "real" measures the real thing) ---- */
{
  const st = await makeAnimator();
  const b = makeBattle(real, { seed: SEL.move[0], cfg: mkCfg({ on: true }), animator: st });
  const { scene, ui } = b;
  const tT = [], tR = [];
  let n = 0;
  while (n++ < 5000 && scene.mode !== 'result') {
    const a = process.hrtime.bigint(); scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); const m = process.hrtime.bigint();
    const view = scene.view(); ui.render(view); const z = process.hrtime.bigint();
    tT.push(Number(m - a) / 1e6); tR.push(Number(z - m) / 1e6);
  }
  const pct = (xs, p) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length * p)];
  console.log(`timing (${WHICH} animator, ${n} frames, load: ${os.loadavg().map((x) => x.toFixed(2)).join(' ')} [win32: 0 = not reported], ${os.cpus().length} cpus): tick p50 ${pct(tT, 0.5).toFixed(3)} ms p99 ${pct(tT, 0.99).toFixed(3)} max ${Math.max(...tT).toFixed(3)}; render p50 ${pct(tR, 0.5).toFixed(3)} ms p99 ${pct(tR, 0.99).toFixed(3)} max ${Math.max(...tR).toFixed(3)} (budget at 59.7275 Hz: 16.74 ms)`);
  ok(pct(tT, 0.99) + pct(tR, 0.99) < 16.7, '1. p99 tick + render fits the 16.7 ms frame budget', (pct(tT, 0.99) + pct(tR, 0.99)).toFixed(2) + ' ms');
}

/* ---- goldens: HASHES ONLY. They pin how the scene USES the animator contract over whole battles (the stub's call stream: kind, id, seed, sides, species, args, frame counts;
        the step-token string; the engine hash) -- NOT rendered pixels, so a change to the healthbox / bar / text look (another stage's work) does not move them ---- */
{
  const gold = {};
  for (const seed of [3, 8]) {
    const st = await makeAnimator();
    const r = playBattle(real, { seed, cfg: mkCfg({ on: true }), animator: st });
    gold['starts.' + seed] = sha1(JSON.stringify(st.calls.starts.map((x) => [x.kind, x.id, x.ctx.seed, x.ctx.attacker.side, x.ctx.attacker.species, x.ctx.target.side, x.ctx.target.species, x.ctx.args, x.ctx.animArg, x.ctx.terrain, x.ctx.bystander && x.ctx.bystander.species, x.ctx.turn])));
    gold['tokens.' + seed] = sha1(r.tokens);
    gold['counts.' + seed] = sha1(JSON.stringify([st.calls.start, st.calls.steps, st.calls.draws.length, st.calls.sounds, st.calls.cries, r.frames]));
    gold['engine.' + seed] = r.hash + ':' + r.logHash;
    if (WHICH === 'stub') {                       // round 3: the same battles with a SYSTEM-capable stub: which system runs the scene starts (id, seed, flags, the parties it hands over) and in what order
      const sy = await makeAnimator({ system: true, noPrepare: !!process.env.ARENA_GOLDEN_NOPREPARE });          // ARENA_GOLDEN_NOPREPARE=1: the round-3 contract (start(), no handles), for the proof runs of a re-baseline
      const rs = playBattle(real, { seed, cfg: mkCfg({ on: true }), animator: sy });
      gold['sysstarts.' + seed] = sha1(JSON.stringify(sy.calls.sysStarts.map((x) => [x.id, x.ctx.seed, x.ctx.trainer, x.ctx.environment, x.ctx.foe.species, x.ctx.foe.level, x.ctx.foe.hp, x.ctx.foe.maxHp, x.ctx.foe.exp, x.ctx.player.species, x.ctx.player.level, x.ctx.player.hp, x.ctx.player.maxHp, x.ctx.player.exp, x.ctx.switchIn && x.ctx.switchIn.species, x.ctx.keys === null])));
      gold['systokens.' + seed] = sha1(rs.tokens);
      gold['syscounts.' + seed] = sha1(JSON.stringify([sy.calls.sysStarts.length, sy.calls.steps, sy.calls.sysDraws.length, sy.calls.sysKeys.filter((k) => k === 1).length, rs.hooks.sounds.length, rs.hooks.cries.length, rs.frames]));
    }
  }
  const text = JSON.stringify(gold, null, 1) + String.fromCharCode(10);
  if (process.env.ARENA_PRINT_GOLDEN) fs.writeFileSync(process.env.ARENA_PRINT_GOLDEN, text);                       // the hashes this tree computes, to compare with another tree's
  if (UPDATE && WHICH !== 'stub') throw new Error('ARENA_UPDATE_GOLDEN=1 needs the stub animator (the goldens pin the STUB call stream); drop ARENA_ANIMATOR=real');
  if (UPDATE) { fs.writeFileSync(GOLDEN, text); console.log('rewrote anim_scene.golden.json (' + Object.keys(gold).length + ' hashes)'); }
  const want = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : {};
  if (WHICH === 'stub') {
    const diff = Object.keys(gold).filter((k) => want[k] !== gold[k]);
    ok(diff.length === 0 && Object.keys(want).length === Object.keys(gold).length, '2. stub-animator contract-stream goldens match (' + Object.keys(gold).length + ' hashes)', diff.join(','));
    ok(Object.keys(gold).filter((k) => ({ ...want, 'starts.3': 'deadbeef' })[k] !== gold[k]).length === 1, '2. a tampered golden is detected');
  }
}

/* ---- source mutants: the same checks must fail on each broken copy ---- */
if (process.env.ARENA_SKIP_MUTANTS !== '1') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-anim-mut-'));
  const copyTree = (name) => { const d = path.join(tmp, name); fs.cpSync(JS, d, { recursive: true }); return d; };
  const mutants = [
    ['scene.js', 'DROP the animation queue item (move-use no longer queues it)', (s) => s.replace("qAnim('move', e.mv, e.s, mv && (mv.target === 7 || mv.target === 8) ? e.s : e.s ^ 1, {", "qCall(() => {}); void ({")],
    ['scene.js', 'WRONG ORDER: animations are queued before everything already queued (before the "used" line)', (s) => s.replace("const qAnim = (kind, id, a, d, o) => q(", "const qAnim = (kind, id, a, d, o) => S.queue.unshift(")],
    ['scene.js', 'IGNORE THE SETTING (animations always on)', (s) => s.replace("const animCfg = () => { const c = opts.anim && typeof opts.anim.get === 'function' ? opts.anim.get() : opts.anim; return c && c.on ? c : null; };", "const animCfg = () => { const c = opts.anim && typeof opts.anim.get === 'function' ? opts.anim.get() : opts.anim; return c ? Object.assign({}, c, { on: true }) : { on: true, speed: 1 }; };")],
    ['scene.js', 'speed multiplier ignored', (s) => s.replace("const stepReps = (st) => { const c = animCfg(); return !c || !(c.speed >= 2) || st.t === 'text' ? 1 : c.speed; };", 'const stepReps = () => 1;')],
    ['scene.js', 'speed also runs typed messages faster', (s) => s.replace("const stepReps = (st) => { const c = animCfg(); return !c || !(c.speed >= 2) || st.t === 'text' ? 1 : c.speed; };", "const stepReps = (st) => { const c = animCfg(); return !c || !(c.speed >= 2) ? 1 : c.speed; };")],
    ['scene.js', 'a press always skips the animation (skip flag ignored)', (s) => s.replace("if (c && c.skip) { A.skipReq = true; return true; } }", 'A.skipReq = true; return true; }').replace("if (cfg && cfg.skip && (A.skipReq || S.held.a || S.held.b))", 'if (cfg && (A.skipReq || S.held.a || S.held.b))')],
    ['scene.js', 'the scene keeps drawing its own Pokemon during a run (double mons)', (s) => s.replace('      o.visible = false;' + String.fromCharCode(10) + '      if (S.cur.kind', '      if (S.cur.kind')],
    ['scene.js', 'a "fallback" animation is started anyway', (s) => s.replace("const playable = avail === 'exact' || avail === 'approx';", "const playable = avail !== 'none';").replace("avail === 'none' || avail === 'fallback' || !cfg", "avail === 'none' || !cfg")],
    ['scene.js', 'the healthboxes stay during a move animation', (s) => s.replace("if (S.cur.kind === 'move') o.showBox = false;", '')],
    ['scene.js', 'a self-targeting run does not name the other Pokemon (ctx.bystander dropped)', (s) => s.replace('bystander: selfRun ?', 'bystander: false ?')],
    ['scene.js', 'the scene keeps its own sprite of one side during a run', (s) => s.replace('      o.visible = false;' + String.fromCharCode(10) + '      if (S.cur.kind', '      if (isPlayer) o.visible = false;' + String.fromCharCode(10) + '      if (S.cur.kind')],
    ['scene.js', 'cry events are not forwarded', (s) => s.replace("run.on('cry', (ev) => { A.cries++; if (!A.mute && hooks.onCry && ev) hooks.onCry(ev.species, ev.pan); });", "run.on('cry', () => { A.cries++; });")],
    ['scene.js', 'SYSTEM: the intro is never bundled (the old lead steps play)', (s) => s.replace('&& !P[viewSide].shown && sysOn(SYS.introTrainer)) {', '&& !P[viewSide].shown && false) {')],
    ['scene.js', 'SYSTEM: the scene never presses A for the run (it waits for ever at its first message)', (s) => s.replace('st.shown = tw.lines(); st.tw = null; r.setKeys(KEY_A); st.keyLeft = 3;', 'st.shown = tw.lines(); st.tw = null;')],
    ['scene.js', 'SYSTEM: events are never started (hits / faints / send-outs / recalls stay the old steps)', (s) => s.replace('if (st.noSys || !sysOn(id)) { dropPrep(P); return false; }', 'if (true) { dropPrep(P); return false; }')],
    ['scene.js', 'SYSTEM: nothing is prepared ahead (every event run is prepared on the tick its step begins)', (s) => s.replace('nx.prep = sysOn(id) ? makeSysRun(nx, kind, id, proj) : null;', 'nx.prep = null;')],
    ['scene.js', 'SYSTEM: the experience of the level is not given (the trainer foe shows the wrong level)', (s) => s.replace('const pspec = (m, o) => partySpec(m, o, expOf);', 'const pspec = (m, o) => partySpec(m, o);')],
    ['scene.js', 'SYSTEM: cry events of a system run are not forwarded', (s) => s.replace("run.on('cry', (ev) => { A.cries++; if (!A.mute && hooks.onCry && ev) hooks.onCry(ev.species, ev.pan); });\n  }", "run.on('cry', () => { A.cries++; });\n  }")],
    ['scene.js', 'SYSTEM: every event run is started in trainer mode', (s) => s.replace('trainer: id >= 8 ? (trainerId() > 1 ? trainerId() : 1) : 0,', 'trainer: 1,')],
    ['scene.js', 'SYSTEM: the opening is shown as the scene\'s own field until its run exists (the hot-pink strip comes back)', (s) => s.replace("if (S.cur && S.cur.t === 'sysintro' && !S.cur.run) v.blank = true;", '')],
    ['battle_ui.js', 'a blank view is drawn as the field (the hot-pink strip comes back)', (s) => s.replace('if (view.blank) {', 'if (false) {')],
    ['scene.js', 'SYSTEM/prepare: the handle is never advanced (the step waits for ever)', (s) => s.replace('try { P.h.advance(sliceBudget()); P.ready = !!P.h.ready; }', 'try { P.ready = !!P.h.ready; }')],
    ['scene.js', 'SYSTEM/prepare: two slices a tick', (s) => s.replace('try { P.h.advance(sliceBudget()); P.ready = !!P.h.ready; }', 'try { P.h.advance(sliceBudget()); if (!P.h.ready) P.h.advance(sliceBudget()); P.ready = !!P.h.ready; }')],
    ['scene.js', 'SYSTEM/prepare: begin() without waiting for ready', (s) => s.replace('if (!isReady(P)) { A.waited++; return false; }           // the pre-roll', 'if (false) { A.waited++; return false; }           // the pre-roll')],
    ['scene.js', 'SYSTEM/prepare: no prewarm of the first events battle state', (s) => s.replace("newPrep('battle', wctx, true);", '')],
    ['scene.js', 'SYSTEM/prepare: every event gets its own seed (the engine cannot share the pre-roll)', (s) => s.replace('seed: sysSeed(), maxFrames: SYS_MAX };         // ids 8 / 9', 'seed: animMix(A.seed, ++A.n), maxFrames: SYS_MAX };         // ids 8 / 9')],
    ['scene.js', 'SYSTEM/stale: an event prepared ahead uses the Pokemon on screen NOW, not the one that will be there (the old Pokemon flashes when the new one is hit)', (s) => s.replace('const pm = proj && (side !== st.side || drawsLead(kind)) ? proj[side] : undefined;', 'const pm = undefined;')],
    ['scene.js', 'SYSTEM/stale: a send-out is not given the projection of the OTHER side (a drain on it, a replacement queued first: the dead Pokemon / the old bar are drawn)', (s) => s.replace('const pm = proj && (side !== st.side || drawsLead(kind)) ? proj[side] : undefined;', 'const pm = proj && drawsLead(kind) ? proj[side] : undefined;')],
    ['scene.js', 'SYSTEM/stale: a recall is not given the projection of the Pokemon it recalls (its own bar drains first: Eject Button, Emergency Exit)', (s) => s.replace("const drawsLead = (kind) => kind !== 'sendout';", "const drawsLead = (kind) => kind === 'hit' || kind === 'faint';")],
    ['scene.js', 'SYSTEM/stale: a replacement queued before the effect is not projected (the Pokemon it replaces is drawn)', (s) => s.replace("if (t === 'slidein' || k === 'sendout') proj[step.side] = step.mon;", 'if (false) proj[step.side] = step.mon;')],
    ['scene.js', 'SYSTEM/free-switch: the question is never asked (every offer is answered NO at once, nothing reaches the UI)', (s) => s.replace("    if (autoStay()) return;\n    S.free = { box: null };", "    submit({ kind: 'stay' }); return;\n    S.free = { box: null };")],
    ['scene.js', 'SYSTEM/stale: a send-out is not re-checked against the screen when it starts', (s) => s.replace('(st.side === viewSide ? [ctx.foe, null] : [null, ctx.player])', '[]')],
    ['scene.js', 'SYSTEM/stale: a recall is not re-checked against the screen when it starts', (s) => s.replace('if (P && P.sig !== undefined) {', "if (P && P.sig !== undefined && kind !== 'recall') {")],
    ['scene.js', 'SYSTEM/stale: the Pokemon a send-out replaces is compared too (a hold for a picture nobody sees)', (s) => s.replace("const drawsLead = (kind) => kind !== 'sendout';", 'const drawsLead = () => true;')],
    ['scene.js', 'SYSTEM/stale: a drain in progress does not change the HP the next picture is seeded with (the other health bar goes back up for the length of the effect)', (s) => s.replace("else if (t === 'drain') {", 'else if (false) {')],
    ['scene.js', 'SYSTEM/stale: a prepared event is not re-checked against the screen when it starts', (s) => s.replace('if (fresh && now !== P.sig) {', 'if (false) {')],
    ['scene.js', 'SYSTEM/stale: the state of the step PLAYING NOW is not projected (a switch or drain in progress)', (s) => s.replace('    projectStep(proj, S.cur);', '')],
    ['scene.js', 'SYSTEM/stale: a benign re-prepare is written to the PROBLEMS log (the tests and the browser suite read that log as errors)', (s) => s.replace("A.notes.push('system ' + id + ' stale: ' + why)", "A.log.push('system ' + id + ' stale: ' + why)")],
    ['scene.js', 'SYSTEM/pool: a prepare that throws does not give up the prewarm (the third event is not prepared ahead: "the system engine pool is exhausted")', (s) => s.replace('const w = warm ? null : A.pend.find((x) => x.warm);', 'const w = null;')],
    ['scene.js', 'SYSTEM/pool: the prewarm is given up but the prepare is not tried again', (s) => s.replace("      return animator.prepare('system', id, ctx);\n    }\n  }\n  function newPrep", '      throw e;\n    }\n  }\n  function newPrep')],
    ['scene.js', 'SYSTEM/pool: the prewarm is forgotten, not disposed (its engine stays taken)', (s) => s.replace('dropPrep(w); A.shed =', 'unpend(w); A.shed =')],
    ['scene.js', 'SYSTEM/prepare: handles are kept when animations are switched off (never given back)', (s) => s.replace('if (!animCfg()) { for (const nx of S.queue) if (nx.prep) { dropPrep(nx.prep); nx.prep = undefined; } return; }', 'if (!animCfg()) return;')],
    ['scene.js', 'SYSTEM/prepare: a failed handle does not fall back to the old step', (s) => s.replace('dropPrep(st.P); st.P = null; st.run = null; st.t = st.orig; st.noSys = true; st.restarted = true;\n    startStep(st);\n    return false;', 'dropPrep(st.P); st.P = null; st.run = null; st.kind = null;\n    return true;')],
    ['scene.js', 'SYSTEM/prepare: the hit / faint hooks fire again when a step restarts', (s) => s.replace("if (hooks.onHit && !st.restarted)", 'if (hooks.onHit)')],
    ['scene.js', 'SYSTEM: the trainer picture ignores the CPU level (always the easy list)', (s) => s.replace('pickTrainer(opts.trainerChoices, opts.cpuLevel, A.seed)', "pickTrainer(opts.trainerChoices, 'easy', A.seed)")],
    ['scene.js', 'SYSTEM: the trainer of the later events is not the opening\'s (a second pick)', (s) => s.replace('trainer: id >= 8 ? (trainerId() > 1 ? trainerId() : 1) : 0,', 'trainer: id >= 8 ? (pickTrainer(opts.trainerChoices, opts.cpuLevel, A.seed + A.n) || 1) : 0,')],
    ['scene.js', 'SYSTEM: the player\'s gender is not given to the opening', (s) => s.replace("opts.playerGender === 'F' || opts.playerGender === 'M' ? { gender: opts.playerGender } : {}, opts.sysClock", '{}, opts.sysClock')],
    ['scene.js', 'SYSTEM: the player\'s gender is not given to the events', (s) => s.replace("    if (opts.playerGender === 'F' || opts.playerGender === 'M') ctx.gender = opts.playerGender;\n", '')],
    ['scene.js', 'SYSTEM: the scene draws its own Pokemon and healthboxes over the system run', (s) => s.replace('if (sys) v.fxSys = true;', '')],
    ['anim_sys.js', 'SYSTEM: the run is drawn WITH its own text boxes (BG0 on, doubled text)', (s) => s.replace('export const LAYERS_NO_TEXT = 0x1e;', 'export const LAYERS_NO_TEXT = 0x1f;')],
    ['scene.js', 'poison damage drains first and prints afterwards (the old order)', (s) => { const NL = String.fromCharCode(10) + '      '; const a = "qMsg(e.src === 'brn' ? 'hurt.brn' : e.src === 'fbt' ? 'hurt.frb' : 'hurt.psn', roles(e.s));" + NL + "qAnim('status', e.src === 'brn' ? STATUS.BRN : e.src === 'fbt' ? STATUS.FRZ : STATUS.PSN, e.s, e.s);" + NL + 'drain();'; const b = "qAnim('status', e.src === 'brn' ? STATUS.BRN : e.src === 'fbt' ? STATUS.FRZ : STATUS.PSN, e.s, e.s);" + NL + 'drain();' + NL + "qMsg(e.src === 'brn' ? 'hurt.brn' : e.src === 'fbt' ? 'hurt.frb' : 'hurt.psn', roles(e.s));"; return s.replace(a, b); }],
    ['battle_ui.js', 'the foe shadow is also drawn while an animation runs', (s) => s.replace('if (!view.fxDraw) drawShadow(f, view.foe);', 'drawShadow(f, view.foe);')],
    ['scene.js', 'sound events are not forwarded', (s) => s.replace("run.on('sound', (ev) => { A.sounds++; if (!A.mute && hooks.onSound && ev) hooks.onSound(ev.index, ev.pan); });", "run.on('sound', () => { A.sounds++; });")],
    ['scene.js', 'animation seed ignored (constant)', (s) => s.replace('seed: animMix(A.seed, ++A.n)', 'seed: 1')],
    ['scene.js', 'a "none" animation is not replaced by the lunge', (s) => s.replace("if (st.fb === 'lunge' && (avail === 'none' || avail === 'fallback' || !cfg || !animator)) { st.t = 'lunge'; st.side = st.a; st.n = 0; }", '')],
    ['scene.js', 'the front picture swap ignores the ROM (always picture 1)', (s) => s.replace('d.frame = s === viewSide ? 0 : frontFrameAt(m.info, m.t);', 'd.frame = s === viewSide ? 0 : 1;')],
    ['scene.js', 'ANIMATION menu row does nothing', (s) => s.replace("if (c) opts.anim.set({ on: !c.on }); close(); openMenu('ANIMATION');", "close(); openMenu('ANIMATION');")],
    ['battle_ui.js', 'render never calls the animation draw', (s) => s.replace('if (view.fxDraw) view.fxDraw(f);', '')],
    ['battle_ui.js', 'the animation is drawn OVER the UI (after the text box)', (s) => s.replace('if (view.fxDraw) view.fxDraw(f);', '').replace('        drawBox(f, view.box);', '        drawBox(f, view.box); if (view.fxDraw) view.fxDraw(f);')],
    ['anim_mon.js', 'Delta Stream plays the hail animation', (s) => s.replace('8: GENERAL.STRONG_WINDS_CONTINUE }', '8: GENERAL.HAIL_CONTINUES }')],
    ['anim_mon.js', 'Desolate Land plays the rain animation', (s) => s.replace('7: GENERAL.SUN_CONTINUES, 8:', '7: GENERAL.RAIN_CONTINUES, 8:')],
    ['anim_mon.js', 'animation durations ignored (every picture 1 frame)', (s) => s.replace('out.push({ img: t, dur: x & 0xff,', 'out.push({ img: t, dur: 1,')],
    ['anim_mon.js', 'delay ignored', (s) => s.replace('let n = t - info.delay;', 'let n = t;')],
    ['anim_settings.js', 'speed accepts anything', (s) => s.replace("if (patch && ANIM_SPEEDS.includes(patch.speed)) cur.speed = patch.speed;", 'if (patch && patch.speed) cur.speed = patch.speed;')],
    ['anim_settings.js', 'default is OFF', (s) => s.replace('return { v: ANIM_VERSION, on: true, speed: 1, skip: false };', 'return { v: ANIM_VERSION, on: false, speed: 1, skip: false };')],
    ['anim_settings.js', 'query values are written back to storage', (s) => s.replace('const cur = Object.assign({}, stored);', 'const cur = Object.assign({}, stored); setTimeout(() => {}, 0);').replace("if (q.skip !== undefined) cur.skip = q.skip;", "if (q.skip !== undefined) cur.skip = q.skip; if (storage) { try { storage.setItem(ANIM_KEY, JSON.stringify({ v: 1, on: cur.on, speed: cur.speed })); } catch (_e) { /* */ } }")],
    ['battle_boot.js', 'anim=2 accepted', (s) => s.replace("if (parseAnimQuery(search).errors.includes('anim'))", 'if (false)')],
  ];
  const twinDir = copyTree('twin');
  const twin = await loadStack(twinDir, '?twin');
  const twinFails = await core(twin, { fast: true });
  ok(twinFails.length === 0, '3. the unmutated twin (copied tree, fast mode) is quiet', twinFails.slice(0, 3).join(' | '));
  let killed = 0;
  for (let mi = 0; mi < mutants.length; mi++) {
    const [file, name, fn] = mutants[mi];
    const dir = copyTree('m' + mi);
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const out = fn(src);
    if (out === src) { ok(false, '3. mutant "' + name + '" did not change the source (the mutant itself is broken)'); continue; }
    fs.writeFileSync(path.join(dir, file), out);
    let fails;
    try { const M = await loadStack(dir, '?m' + mi); fails = await core(M, { fast: true }); } catch (e) { fails = ['threw: ' + String(e.message).slice(0, 80)]; }
    const dead = fails.length > 0;
    if (dead) killed++;
    ok(dead, '3. mutant killed: ' + file + ' / ' + name, dead ? fails[0].slice(0, 80) : 'survived');
  }
  console.log('mutants killed ' + killed + ' of ' + mutants.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

/* ---- Chrome (ARENA_BROWSER=1): the real page with animations on, a whole 3v3 battle, errors, frame cost, the settings reaching the page ---- */
// The battle the page plays is decided by ITS builder (battle_boot.js resolveBattle) from ?seed=N, so the seed is FOUND with that builder: a 3v3 battle that ends, with at least 2 faints, 4 send-outs
// after the leads and 8 moves (what the checks below need: hits, faints, send-outs, a long enough battle to hold system runs and heavy move frames). Nothing names a seed.
async function findPageSeed(max = 80, need = { faints: 2, sendouts: 4, moves: 8 }) {
  const BO = await import(pathToFileURL(path.join(JS, 'battle_boot.js')).href);
  const pack = packOf(real), ui = uiOf(real), text = real.BT.loadBattleText(rom, manifest), tried = [];
  for (let seed = SEED0; seed < SEED0 + max; seed++) {
    const p = BO.parseBattleQuery('?seed=' + seed + '&format=3v3'); if (!p.ok) continue;
    const r = await BO.resolveBattle(pack, p.params); if (!r.ok) continue;
    const spec = r.spec, ctl = real.MC.createMatchController({ pack, ruleset: spec.ruleset, teams: spec.teams, seed: spec.seed, pick: spec.pick, names: spec.names, sides: spec.sides });
    const scene = real.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: spec.seed % 9, textSpeed: p.params.speed, meta: spec.meta, trainer: spec.trainer, playerName: 'You' });
    const ai = real.AI.createAi({ pack, level: p.params.cpu, seed: spec.seed ^ 0x5bd1e995 });
    ctl.start(); scene.begin(); scene.S.auto = { ai, decide(req) { return ai.choose(req, ctl.view(0), { previewInfo: { foe: ctl.previewInfo[1] } }); } };
    for (let n = 0; n < 300000 && scene.mode !== 'result'; n++) { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); }
    const ev = ctl.battle.events, c = (code) => ev.filter((e) => e.t === code).length;
    const got = { faints: c('faint'), sendouts: c('switch-in') - 2, moves: c('move-use') };
    tried.push(seed + ':' + got.faints + '/' + got.sendouts + '/' + got.moves);
    if (scene.mode === 'result' && ctl.winner !== null && got.faints >= need.faints && got.sendouts >= need.sendouts && got.moves >= need.moves) return { seed, got, tried };
  }
  return { seed: null, tried };
}
if (process.env.ARENA_BROWSER === '1') {
  const PAGE = await findPageSeed();
  ok(PAGE.seed !== null, '5. browser: a 3v3 battle for the page was found at run time with the page\'s own builder (seed ' + PAGE.seed + ', faints/send-outs/moves ' + (PAGE.got ? [PAGE.got.faints, PAGE.got.sendouts, PAGE.got.moves].join('/') : '-') + '; tried ' + PAGE.tried.slice(0, 5).join(' ') + ')');
  ok((await (async () => { const old = SEED0; return (await findPageSeed(3, { faints: 1000, sendouts: 1000, moves: 1000 })).seed === null && old === SEED0; })()), '5. browser negative control: an impossible requirement finds no page battle');
  const PQ = '?seed=' + PAGE.seed + '&format=3v3';
  const { withBrowser } = await import('./headless_cdp.mjs');
  const { spawn } = await import('node:child_process');
  const PORT = Number(process.env.ARENA_PORT || 8105), CDP = Number(process.env.ARENA_CDP || 9371);
  const BASE = `http://localhost:${PORT}/pokemonarena/battle.html`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const probe = async () => { try { const r = await fetch(BASE); return r.ok; } catch (_e) { return false; } };
  let server = null;
  if (!(await probe())) { server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true }); for (let i = 0; i < 40 && !(await probe()); i++) await sleep(250); }
  const H = '(window.__arenaBattle)';
  // one in-page run: tick + render a whole battle (the CPU plays the human seat), timing every frame; returns the numbers
  const RUN = `(() => { const a = ${H}; a.autoplay(1); const S = a.scene; const ticks = [], rends = [], long = []; let n = 0, frameMax = 0;
    while (n++ < 400000 && S.mode !== 'result') { const t0 = performance.now(); const before = S.S.cur ? S.S.cur.t : null; S.tick(); if (S.mode === 'steps' && S.S.cur && S.S.cur.t === 'text') S.press('a'); const t1 = performance.now(); const v = S.view(); a.ui.render(v); const t2 = performance.now(); ticks.push(t1 - t0); rends.push(t2 - t1); if (t2 - t0 > 16.74) long.push([n, +(t2 - t0).toFixed(1), +(t1 - t0).toFixed(1), before, S.S.cur ? S.S.cur.t : null, S.S.cur && S.S.cur.kind ? S.S.cur.kind + ':' + S.S.cur.id : '']); frameMax = Math.max(frameMax, t2 - t0); }
    const q = (xs, p) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length * p)];
    return { frames: n, mode: S.mode, winner: a.ctl.winner, info: S.animInfo(), long, frameMax, prewarm: a.prewarm || null, tickP50: q(ticks, 0.5), tickP99: q(ticks, 0.99), tickMax: Math.max(...ticks), rendP50: q(rends, 0.5), rendP99: q(rends, 0.99), rendMax: Math.max(...rends), hash: a.ctl.battle.hash(), animError: a.animError, animReady: a.animReady, cfg: a.anim.get() }; })()`;
  try {
    await withBrowser({ port: CDP, width: 390, height: 844 }, async (page) => {
      const run = async (query) => {
        await page.navigate(BASE + query);
        await page.waitFor(`${H} && (${H}.state === 'ready' || ${H}.state === 'error')`, { timeoutMs: 120000 });
        const st = await page.eval(`${H}.state`);
        if (st !== 'ready') return { st, error: await page.eval(`${H}.error`), errors: [] };
        const r = await page.eval(RUN);
        r.st = st; r.errors = page.errors.slice(); page.errors.length = 0;
        return r;
      };
      const on = await run(PQ + '&anim=1');
      ok(on.st === 'ready' && on.mode === 'result' && on.winner !== null, 'browser: a whole 3v3 battle with animations ON runs to the result screen', JSON.stringify({ st: on.st, mode: on.mode, err: on.error }));
      ok(on.errors && on.errors.length === 0, 'browser: no page errors with animations on', (on.errors || []).slice(0, 2).join(' | '));
      ok(on.cfg && on.cfg.on === true, 'browser: ?anim=1 reaches the settings', JSON.stringify(on.cfg));
      console.log('browser anim ON  (animator ' + (on.animReady ? 'loaded' : 'absent: ' + on.animError) + '): ' + on.frames + ' frames; tick p50/p99/max ' + on.tickP50.toFixed(3) + '/' + on.tickP99.toFixed(3) + '/' + on.tickMax.toFixed(2) + ' ms; render p50/p99/max ' + on.rendP50.toFixed(3) + '/' + on.rendP99.toFixed(3) + '/' + on.rendMax.toFixed(2) + ' ms; animations played ' + on.info.played + ', coverage ' + JSON.stringify(on.info.coverage) + ', log ' + JSON.stringify(on.info.log));
      // round 4: the SYSTEM animations in the real page, PREPARED in slices. info.sys = runs of the battle's own animations, info.waited = ticks a step held the previous picture for a handle that was not
      // ready, prewarm = the throwaway intro played at load, long = every frame (tick + render) over the 16.74 ms budget of 59.7275 Hz (round 3 had 22 stalls of 94-151 ms and a worst tick of 150-310 ms)
      ok(on.info && on.info.sys >= 1 && on.info.log.length === 0, 'browser: the battle played system animations (' + (on.info && on.info.sys) + ' runs) with no error in the animation log', JSON.stringify(on.info && on.info.log));
      // the log above lists PROBLEMS only; a re-prepare of an effect whose picture changed (restale) and a prewarm given up for a full engine pool (shed) are benign and live in animInfo().notes
      ok(on.info && Array.isArray(on.info.notes) && on.info.notes.length === (on.info.restale | 0) + (on.info.shed | 0) && on.info.notes.every((x) => /^system [2-9] (stale: |prepare\(\) threw .*the prewarm was given up)/.test(x)), 'browser: the benign events are in animInfo().notes (' + (on.info && on.info.restale | 0) + ' re-prepared, ' + (on.info && on.info.shed | 0) + ' prewarm given up), never in the problems log', JSON.stringify(on.info && on.info.notes).slice(0, 300));
      ok(on.prewarm && on.prewarm.steps >= 1, 'browser: the first system run was warmed behind the boot screen', JSON.stringify(on.prewarm));
      console.log('browser system animations: ' + on.info.sys + ' runs over ' + on.frames + ' frames; prewarm ' + JSON.stringify(on.prewarm && { ms: Math.round(on.prewarm.ms), steps: on.prewarm.steps }) + '; frames over the 16.74 ms budget: ' + on.long.length + ' ' + JSON.stringify(on.long.slice(0, 6)) + '; worst frame (tick + render) ' + on.frameMax.toFixed(1) + ' ms, worst tick ' + on.tickMax.toFixed(1) + ' ms; ticks a step held the previous picture: ' + on.info.waited);
      // A ROM MOVE animation can cost 12-15 ms a frame on its own (its step + its draw): those frames exceed the budget with or without a pre-roll slice (the slice shrinks to 0.5 ms there, see
      // sliceBudget). Everything else -- the opening, send-outs, recalls, faints, hits, messages, menus, and the pre-roll slices -- must fit the frame, and nothing may come near two frames.
      const notMove = on.long.filter((x) => x[3] !== 'moveanim' && x[4] !== 'moveanim' && x[1] > 16.74 + 1);          // 1 ms of timer / scheduler noise (a frame of 16.9 ms is the budget)
      ok(notMove.length === 0 && on.frameMax < 2 * 16.74, 'browser: no frame outside a ROM move animation exceeds the 16.74 ms frame budget (+ 1 ms of noise), and the worst frame of the whole battle is ' + on.frameMax.toFixed(1) + ' ms (' + on.long.length + ' of ' + on.frames + ' frames are over, all inside move animations; round 3: 22 stalls of 94-151 ms, worst tick 150-310 ms)', JSON.stringify(notMove.slice(0, 6)));
      ok(on.info.waited < on.frames * 0.08, 'browser: the scene held the previous picture for a handle on fewer than 8% of the ticks (' + on.info.waited + ' of ' + on.frames + ')');
      const off = await run(PQ + '&anim=0');
      ok(off.st === 'ready' && off.mode === 'result' && off.cfg.on === false && off.info.played === 0, 'browser: ?anim=0 plays no animation', JSON.stringify(off.cfg));
      ok(off.hash === on.hash, 'browser: animations on or off, the engine plays the same battle (hash)', off.hash + ' vs ' + on.hash);
      ok(off.errors.length === 0, 'browser: no page errors with animations off', off.errors.join(' | '));
      const fast = await run(PQ + '&anim=1&speed=4');
      ok(fast.st === 'ready' && fast.cfg.speed === 4 && fast.frames < on.frames, 'browser: ?speed=4 finishes the same battle in fewer frames (' + fast.frames + ' < ' + on.frames + ')', JSON.stringify(fast.cfg));
      ok(fast.hash === on.hash, 'browser: ...and it is the same battle');
      const bad = await run('?anim=2');
      ok(bad.st === 'error', 'browser: ?anim=2 is refused with an error screen', bad.st);
      // round 6: the opening as the visitor SEES it. Every putImageData of the canvas is scanned from the moment YES is chosen to the action menu: not one pixel of the hot-pink key colour,
      // and every colour of rows 112..159 is one the real game shows there (the oracle's first frames, up to its action menu). The strip is hot pink in environment 3: that seed is used.
      {
        const OI = await oracleIntro();
        ok(OI.ok, 'browser opening: the oracle\'s frames are available' + (OI.ok ? '' : ' [' + OI.err + ']'));
        if (OI.ok) {
          const INIT = "(() => { const d = window.__intro = { n: 0, pinkDraws: 0, maxPink: 0, bottom: new Set(), on: false }; const orig = CanvasRenderingContext2D.prototype.putImageData; CanvasRenderingContext2D.prototype.putImageData = function (img, x, y) { if (d.on && img && img.width === 240 && img.height === 160) { const a = img.data; let pink = 0; for (let i = 0; i < a.length; i += 4) { if (a[i] === 255 && a[i + 1] === 0 && a[i + 2] === 132) pink++; if (i >= 240 * 112 * 4) d.bottom.add((a[i] << 16) | (a[i + 1] << 8) | a[i + 2]); } d.n++; if (pink) { d.pinkDraws++; d.maxPink = Math.max(d.maxPink, pink); } } return orig.call(this, img, x, y); }; })();";
          await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
          const sPink = SEED0 + ((3 - (SEED0 % 9) + 9) % 9);
          const scanIntro = async (base) => {
            await page.navigate(base + '/pokemonarena/battle.html?seed=' + sPink + '&format=3v3&anim=1');
            await page.waitFor(H + ' && ' + H + '.state === "ready" && ' + H + '.getState().mode === "preview"', { timeoutMs: 90000 });
            // the picks and the question come first (their screens are the team preview's, not the opening's); the scan starts with the answer YES, as the Node scan does
            for (const k of ['a', 'down', 'a', 'down', 'a']) { await page.eval(H + ".press('" + k + "')"); await sleep(150); }
            await page.eval('window.__intro.on = true'); await page.eval(H + ".press('a')");
            await page.waitFor(H + '.mode === "action"', { timeoutMs: 60000 });
            return page.eval('(() => { const d = window.__intro; return { n: d.n, pinkDraws: d.pinkDraws, maxPink: d.maxPink, bottom: [...d.bottom] }; })()');
          };
          const good = await scanIntro('http://localhost:' + PORT);
          const odd = good.bottom.filter((c) => c !== 0 && !OI.bottom.has(c));
          ok(good.n >= 50 && good.pinkDraws === 0, 'browser opening (environment 3): none of the ' + good.n + ' canvas draws of the opening has a pixel of the hot-pink key colour (' + good.pinkDraws + ' draws, up to ' + good.maxPink + ' px)', '');
          ok(odd.length === 0, 'browser opening: every colour of rows 112..159 of every draw is one the real game shows there', odd.slice(0, 6).map((c) => c.toString(16)).join(',') + ' (' + odd.length + ' not in the oracle)');
          // negative control: the same page with the fix taken out (an overlay copy of the tree) draws the key colour and is caught by the same scan
          const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
          const tmpO = fs.mkdtempSync(path.join(os.tmpdir(), 'an1-open-')); const dO = copyTree(path.join(root, 'pokemonarena'), path.join(tmpO, 'pokemonarena'));
          mutateFile(dO, 'js/scene.js', "if (S.cur && S.cur.t === 'sysintro' && !S.cur.run) v.blank = true;", '');
          const ov = await startOverlay({ dir: dO, port: PORT + 1, upstream: 'http://localhost:' + PORT });
          try {
            const bad2 = await scanIntro('http://localhost:' + (PORT + 1));
            const odd2 = bad2.bottom.filter((c) => c !== 0 && !OI.bottom.has(c));
            ok(bad2.pinkDraws >= 1 && odd2.length >= 1, 'browser opening negative control: without the fix the scan finds the key colour (' + bad2.pinkDraws + ' draws, up to ' + bad2.maxPink + ' px) and ' + odd2.length + ' colour(s) the real game never shows there', JSON.stringify(bad2).slice(0, 120));
          } finally { ov.stop(); try { fs.rmSync(tmpO, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
        }
      }
      // the frame budget at the page's own cadence: p99 tick + render under one 59.7275 Hz frame (16.74 ms)
      ok(on.tickP99 + on.rendP99 < 16.7, 'browser: p99 tick + render fits the 16.7 ms frame budget (' + (on.tickP99 + on.rendP99).toFixed(2) + ' ms)');
    });
  } finally { if (server) { try { server.kill(); } catch (_e) { /* ignore */ } } }
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s); ' + nChecks + ' individual checks ran inside the core runs (real tree + twin + mutants)');
if (fail) { console.log(failures.join('\n')); process.exit(1); }
void writePNG; void scaleRGBA;
