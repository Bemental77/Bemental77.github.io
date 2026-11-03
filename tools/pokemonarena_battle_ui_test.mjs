// tools/pokemonarena_battle_ui_test.mjs - Node test for pokemonarena/js/{battle_ui,textfx}.js (no browser)
//
//   node tools/pokemonarena_battle_ui_test.mjs                       # run; exit 1 on any failure
//   ARENA_UPDATE_GOLDEN=1 node tools/pokemonarena_battle_ui_test.mjs  # rewrite pokemonarena/battle_ui.golden.json
//   ARENA_ROM=/path/to.gba  ARENA_OUT=/path/to/pngdir                 # overrides
//
// What it proves, and what would make it fail:
//   1. BAR RULES   hpFillPixels / hpBarColor / drainFrames / expFillPixels against explicit boundary cases and an
//                  independent exhaustive derivation. Each rule has a MUTANT (off-by-one threshold, round instead of
//                  floor, no minimum pixel, drain step 2, wrong scale...) that must trip the same checks, and the
//                  unmutated implementation is run twice and must stay quiet.
//   2. TYPEWRITER  timing arithmetic (n chars at delay d finish in n*(d+1)-d frames), pagination, fast mode; mutants.
//   3. GOLDEN      ~90 rendered frames (every terrain, every menu state, HP bar sweep, status icons, faint, EXP, a
//                  scripted battle) are hashed and compared with pokemonarena/battle_ui.golden.json (hashes only: no
//                  pixels are committed). A tampered golden is shown to fail the comparison.
//   4. PROVENANCE  the pixels come from the ROM: zero the HP-bar tile bytes in a COPY of the ROM and the bar
//                  disappears; zero the font glyph bytes and the text disappears; corrupt the terrain / sprite /
//                  healthbox / textbox / type-icon / text-colour bytes and the output changes. The unmutated twin
//                  copy renders byte-identically.
//   5. DEMO        the scripted battle is deterministic, the foe HP drain is monotonic at one HP per frame and ends on
//                  the damage the Gen-3 formula gives, the cursor moves with the arrow buttons, a faint hides the
//                  sprite, a finished battle resets.
//   6. PURITY      the modules contain no node: / Buffer / require / document / window / Math.random / Date.
//   7. HEALTHBOX   (verifier round) the HP label / bar / EXP bar are assembled across ROM tile boundaries and sit on the
//                  frame art's own geometry (end cap, EXP recess), measured from the decoded frame; level-100 mons gain no
//                  EXP and never loop 'grew to' messages; the name never overlaps the level; move names never leave their
//                  window; hostile views do not throw; the faint sink is exactly 4 px/frame. Each rule is run against SOURCE
//                  mutants of battle_ui.js (patched copies in a temp dir) that must trip it, with the unmutated twin quiet.
//   8. S1 FIX     (verifier round 2) every move name, all 935, shows COMPLETE in the move menu from ROM glyphs (sweep over every
//                  pack move incl. the 609 a legal team can carry and the 688 the engine supports, by ink-pixel equality, plus
//                  a scroll-coverage proof for the one name that fits no static layout); the party / team-preview / result row
//                  panels, the screen background, the CANCEL button and the RAIN / TRICK ROOM tag plates are cut from ROM art
//                  (hash-pinned decode, ROM-palette provenance, corruption controls), icons never overlap the next row, result
//                  labels never touch their panels. Every rule has a source mutant and an unmutated twin.
// PNG strips go to ARENA_OUT (default: this stage's scratch dir) for opening with an image viewer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG, scaleRGBA, newCanvas, blit } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const OUT = process.env.ARENA_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Dev-Bemental77-github-io/c96e71fd-a869-4d47-86d5-aa19395edeed/scratchpad/U2';
const GOLDEN = path.join(root, 'pokemonarena', 'battle_ui.golden.json');
const UPDATE = process.env.ARENA_UPDATE_GOLDEN === '1';
const mod = (n) => import(pathToFileURL(path.join(root, 'pokemonarena', 'js', n)).href);
const B = await mod('battle_ui.js');
const TX = await mod('textfx.js');
const T = await mod('tables.js');
const U = await mod('uiassets.js');
const S = await mod('speciesgfx.js');
const RU = await mod('rules.js');
const GC = await mod('gfxcodec.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 140) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); }
}
const sha1 = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex'); };

const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
console.log('pokemonarena battle-ui test; ROM', ROM_PATH, romBuf.length, 'B');
ok(crypto.createHash('sha256').update(rom).digest('hex') === U.ROM_SHA256, '0. rom sha256 is the pinned v1.1.1 image');

/* ================================================================== 1. bar rules + mutants */

// An independent derivation of the same numbers (no division-based formula): pixels = how many of the `scale`
// pixel boundaries k/scale the HP has reached, i.e. count of k in 1..scale with hp*scale >= k*max.
function indepPx(hp, max, scale) { let n = 0; for (let k = 1; k <= scale; k++) if (hp * scale >= k * max) n++; return n; }

function checkRules(R) {
  const f = [];
  const t = (name, cond) => { if (!cond) f.push(name); };
  // pinned boundary cases (HP bar is 48 px; at least one pixel while alive). FA1: the COLOUR is the ROM's, read from MoveBattleBar @0x08085ecc
  // and checked against the ROM's own code in tools/pokemonarena_fidelity_test.mjs: green when hp > max/2 (or hp = max), yellow when hp > max/5,
  // else red (max <= 1 stays green); decided on the HP value, NOT on the pixel count (the old rule, > 24 px / > 9 px, was recollection).
  const cases = [[48, 48, 48], [0, 48, 0], [1, 48, 1], [24, 48, 24], [25, 48, 25], [1, 500, 1], [499, 500, 47], [10, 100, 4], [50, 100, 24], [51, 100, 24], [53, 100, 25], [1, 1, 48], [0, 1, 0], [96, 200, 23], [100, 200, 24], [104, 200, 24], [105, 200, 25]];
  for (const [hp, max, px] of cases) t('px(' + hp + '/' + max + ')=' + px, R.hpFillPixels(hp, max) === px);
  const colors = [[48, 48, 'hpGreen'], [25, 48, 'hpGreen'], [24, 48, 'hpYellow'], [10, 48, 'hpYellow'], [9, 48, 'hpRed'], [1, 48, 'hpRed'], [0, 48, 'hpRed'],
    [50, 100, 'hpYellow'], [51, 100, 'hpGreen'], [53, 100, 'hpGreen'], [21, 100, 'hpYellow'], [20, 100, 'hpRed'], [19, 100, 'hpRed'], [100, 100, 'hpGreen'], [1, 1, 'hpGreen'], [1, 500, 'hpRed'], [100, 500, 'hpRed'], [101, 500, 'hpYellow'], [250, 500, 'hpYellow'], [251, 500, 'hpGreen'],
    [13, 25, 'hpGreen'], [12, 25, 'hpYellow'], [6, 25, 'hpYellow'], [5, 25, 'hpRed'], [1, 2, 'hpYellow'], [2, 2, 'hpGreen'], [0, 1, 'hpGreen']];
  for (const [hp, max, c] of colors) t('color(' + hp + '/' + max + ')=' + c, R.hpBarColor(hp, max) === c);
  // exhaustive: every max 1..160, every hp 0..max
  let badPx = 0, nonMono = 0, badColor = 0, over = 0;
  for (let max = 1; max <= 160; max++) {
    let prev = -1;
    for (let hp = 0; hp <= max; hp++) {
      const px = R.hpFillPixels(hp, max);
      const want = hp > 0 ? Math.max(1, indepPx(hp, max, 48)) : 0;
      if (px !== want) badPx++;
      if (px < prev) nonMono++;
      if (px > 48) over++;
      prev = px;
      // the ROM's colour rule written without division (2*hp > max, 5*hp > max): green, yellow, else red (a 1-HP maximum stays green)
      const wc = hp === max || 2 * hp > max ? 'hpGreen' : 5 * hp > max ? 'hpYellow' : (max > 1 ? 'hpRed' : 'hpGreen');
      if (R.hpBarColor(hp, max) !== wc) badColor++;
    }
  }
  t('exhaustive px equals the independent derivation', badPx === 0);
  t('px never decreases as hp rises', nonMono === 0);
  t('px never exceeds the bar', over === 0);
  t('exhaustive colour equals the threshold rule', badColor === 0);
  // drain sequences. FA1: the ROM moves the bar maxHP/24 HP a frame (1 when maxHP < 24; MoveBattleBar @0x08085ecc), clamped onto the target; a
  // bar of maxHP < 48 runs in fixed point and takes 48 frames from full to empty (CalcNewBarValue @0x080839e4)
  const d = R.drainFrames(100, 37, 100);
  t('drain 100->37 (max 100) takes 16 frames (63 HP at floor(100/24) = 4 a frame)', d.length === 16);
  t('drain steps by exactly maxHP/24 = 4 HP a frame', d.slice(0, -1).every((v, i) => v === 96 - 4 * i));
  t('drain ends exactly on the target', d[d.length - 1] === 37);
  t('drain to the same value is empty', R.drainFrames(5, 5, 100).length === 0);
  const up = R.drainFrames(30, 39, 120);
  t('fill 30->39 (max 120) climbs 5 HP a frame and ends on 39', up.length === 2 && up[0] === 35 && up[1] === 39);
  t('drain to zero ends on 0', R.drainFrames(7, 0, 100).slice(-1)[0] === 0);
  { const big = R.drainFrames(714, 0, 714); t('a 714-HP bar empties 29 HP a frame (714/24)', big.length === Math.ceil(714 / 29) && big[0] === 685); }
  { const small = R.drainFrames(30, 0, 30); t('a 30-HP bar (< 48) empties in about 48 frames, not 30', small.length >= 46 && small.length <= 50, 'got ' + small.length);
    t('a fixed-point drain never rises and ends on 0', small.every((v, i) => i === 0 || v <= small[i - 1]) && small[small.length - 1] === 0); }
  // exp bar (64 px)
  t('exp 0/100 = 0 px', R.expFillPixels(0, 100) === 0);
  t('exp 50/100 = 32 px', R.expFillPixels(50, 100) === 32);
  t('exp 100/100 = 64 px', R.expFillPixels(100, 100) === 64);
  t('exp 99/100 = 63 px', R.expFillPixels(99, 100) === 63);
  t('exp 1/200 = 0 px (no minimum for exp)', R.expFillPixels(1, 200) === 0);
  t('exp over-full clamps to 64', R.expFillPixels(500, 100) === 64);
  return f;
}
const REAL = { hpFillPixels: B.hpFillPixels, hpBarColor: B.hpBarColor, drainFrames: B.drainFrames, expFillPixels: B.expFillPixels };
{
  const f1 = checkRules(REAL), f2 = checkRules(REAL);
  ok(f1.length === 0, '1. real bar rules pass every check', f1.slice(0, 6).join('; '));
  ok(f2.length === 0, '1. unmutated twin stays quiet on a second run');
  const scaled = (hp, max, scale = 48) => (max > 0 ? Math.floor((Math.max(0, Math.min(hp, max)) * scale) / max) : 0);
  const mutants = {
    'no minimum pixel while alive': { ...REAL, hpFillPixels: (hp, max) => scaled(hp, max) },
    'round to nearest instead of floor': { ...REAL, hpFillPixels: (hp, max) => (hp > 0 ? Math.max(1, Math.round((hp * 48) / max)) : 0) },
    'green at >= max/2 (not >)': { ...REAL, hpBarColor: (hp, max) => (hp >= max || hp >= Math.floor(max / 2) ? 'hpGreen' : hp > Math.floor(max / 5) ? 'hpYellow' : 'hpRed') },
    'yellow at >= max/5 (not >)': { ...REAL, hpBarColor: (hp, max) => (hp >= max || hp > Math.floor(max / 2) ? 'hpGreen' : hp >= Math.floor(max / 5) ? 'hpYellow' : 'hpRed') },
    'colour from the scaled pixels, > 24 px / > 9 px (the pre-FA1 recollection)': { ...REAL, hpBarColor: (hp, max) => (hp >= max || B.hpFillPixels(hp, max) > 24 ? 'hpGreen' : B.hpFillPixels(hp, max) > 9 ? 'hpYellow' : 'hpRed') },
    'colour from the scaled pixels, >= 24 / >= 9': { ...REAL, hpBarColor: (hp, max) => (hp >= max || B.hpFillPixels(hp, max) >= 24 ? 'hpGreen' : B.hpFillPixels(hp, max) >= 9 ? 'hpYellow' : 'hpRed') },
    'a 1-HP maximum drawn red': { ...REAL, hpBarColor: (hp, max) => (max <= 1 ? 'hpRed' : B.hpBarColor(hp, max)) },
    'bar scale 47 px': { ...REAL, hpFillPixels: (hp, max) => (hp > 0 ? Math.max(1, Math.floor((hp * 47) / max)) : 0) },
    'drain steps one HP per frame (the vanilla Gen-3 rate)': { ...REAL, drainFrames: (a, b) => { const o = []; const s = b < a ? -1 : 1; for (let v = a + s; s < 0 ? v >= b : v <= b; v += s) o.push(v); return o; } },
    'drain steps maxHP/48 per frame (the pre-FA1 arena rate)': { ...REAL, drainFrames: (a, b, max) => { const st = Math.max(1, Math.floor(max / 48)); const o = []; let v = a; while (v !== b) { v = b < a ? Math.max(b, v - st) : Math.min(b, v + st); o.push(v); } return o; } },
    'drain steps two HP per frame': { ...REAL, drainFrames: (a, b) => { const o = []; const s = b < a ? -2 : 2; for (let v = a + s; s < 0 ? v > b : v < b; v += s) o.push(v); o.push(b); return o; } },
    'drain overshoots below the target': { ...REAL, drainFrames: (a, b, m) => { const o = B.drainFrames(a, b, m); if (o.length) o.push(b - 1); return o; } },
    'drain is not monotonic': { ...REAL, drainFrames: (a, b, m) => { const o = B.drainFrames(a, b, m); if (o.length > 3) { const t = o[1]; o[1] = o[2]; o[2] = t; } return o; } },
    'exp bar scaled to 48 px': { ...REAL, expFillPixels: (i, s) => Math.min(48, Math.floor((i * 48) / s)) },
    'exp bar rounds up': { ...REAL, expFillPixels: (i, s) => Math.min(64, Math.ceil((i * 64) / s)) },
  };
  for (const [name, m] of Object.entries(mutants)) { const f = checkRules(m); ok(f.length > 0, '1. mutant "' + name + '" is caught', f.length ? f[0] : 'NOT CAUGHT'); }
}

/* ================================================================== 2. typewriter */

function checkTypewriter(create) {
  const f = [];
  const t = (name, cond) => { if (!cond) f.push(name); };
  const measure = (s) => s.length * 6;
  const run = (text, delay, fast = false, maxW = 208) => {
    const tw = create({ text, measure, maxWidth: maxW, delay });
    let n = 0; while (!tw.done && !tw.waiting && n < 100000) { tw.tick(fast); n++; }
    return { tw, n };
  };
  const text = 'Wild Pikachu appeared!';           // 22 chars
  for (const [name, d] of Object.entries(TX.TEXT_SPEED)) {
    const { tw, n } = run(text, d);
    t(name + ' (delay ' + d + ') finishes in n*(d+1)-d = ' + (22 * (d + 1) - d) + ' frames, got ' + n, n === 22 * (d + 1) - d);
    t(name + ' prints the full text', tw.lines()[0] === text);
  }
  { const { n } = run(text, 4, true); t('fast (A held) prints one char per frame: 22 frames, got ' + n, n === 22); }
  { const tw = create({ text, measure, maxWidth: 208, delay: 4 }); const seen = []; for (let i = 0; i < 12; i++) { tw.tick(); seen.push(tw.shown); } t('mid speed reveals chars at frames 1,6,11', seen[0] === 1 && seen[4] === 1 && seen[5] === 2 && seen[10] === 3); }
  // wrapping + paging
  { const tw = create({ text: 'aaaa bbbb cccc dddd eeee', measure, maxWidth: 6 * 10, delay: 0 }); t('wraps greedily at the pixel width (10 chars)', tw.pages.length === 1 && tw.pages[0][0] === 'aaaa bbbb' && tw.pages[0][1] === 'cccc dddd' || tw.pages.length === 2); }
  { const tw = create({ text: 'one two three four five six seven eight nine ten', measure, maxWidth: 6 * 12, delay: 0, maxLines: 2 });
    t('long text paginates into more than one page', tw.pages.length > 1);
    let n = 0; while (!tw.waiting && !tw.done && n++ < 10000) tw.tick();
    t('a finished non-final page waits for a button', tw.waiting && !tw.done);
    t('next() starts the following page', tw.next() === true && tw.page === 1 && tw.lines().join('') === ''); }
  { const tw = create({ text: 'ab\\pcd', measure, maxWidth: 208, delay: 0 }); t('\\p starts a new page', tw.pages.length === 2 && tw.pages[0][0] === 'ab' && tw.pages[1][0] === 'cd'); }
  { const tw = create({ text: 'ab\ncd', measure, maxWidth: 208, delay: 0 }); t('\\n starts a new line on the same page', tw.pages.length === 1 && tw.pages[0][0] === 'ab' && tw.pages[0][1] === 'cd'); }
  { const tw = create({ text: '{LV}50 {PK}{MN}', measure, maxWidth: 208, delay: 0 }); let n = 0; while (!tw.done && n++ < 100) tw.tick(); t('tokens are single units (never cut in half)', tw.lines()[0] === '{LV}50 {PK}{MN}' && n === 6); }
  return f;
}
{
  const REALTW = TX.createTypewriter;
  const f = checkTypewriter(REALTW), f2 = checkTypewriter(REALTW);
  ok(f.length === 0, '2. real typewriter passes every check', f.slice(0, 5).join('; '));
  ok(f2.length === 0, '2. unmutated twin stays quiet');
  // FA1: measured on the real game: one character per logic frame whatever SLOW/MID/FAST is (tools/pokemonarena_fidelity_test.mjs); 'slow' is arena-only
  ok(TX.TEXT_SPEED.slow === 3 && TX.TEXT_SPEED.mid === 0 && TX.TEXT_SPEED.fast === 0, '2. TEXT_SPEED is 3/0/0 frame waits per char (mid = fast = the real game: 1 char per frame; slow is arena-only)');
  const mut = {
    'delay one frame too long': (o) => REALTW({ ...o, delay: (o.delay || 0) + 1 }),
    'delay one frame too short': (o) => REALTW({ ...o, delay: Math.max(0, (o.delay || 0) - 1) }),
    'ignores maxWidth (never wraps)': (o) => REALTW({ ...o, maxWidth: 100000 }),
    'single-page only': (o) => REALTW({ ...o, maxLines: 99 }),
  };
  for (const [name, c] of Object.entries(mut)) { const r = checkTypewriter(c); ok(r.length > 0, '2. mutant "' + name + '" is caught', r.length ? r[0] : 'NOT CAUGHT'); }
}

/* ================================================================== helpers for rendering */

const pack = T.loadPack(rom, { verify: 'header', dexText: false });
const ui = B.createBattleUi(rom);
const hashFrame = (f) => sha1(f.rgba);
const mon = (o) => Object.assign({ gender: 'M', status: null, shiny: false, drop: 0, visible: true, showBox: true }, o);
const MOVES = [
  { name: 'Thunderbolt', pp: 15, maxPp: 15, type: 14 }, { name: 'Quick Attack', pp: 3, maxPp: 48, type: 1 },
  { name: 'Iron Tail', pp: 0, maxPp: 24, type: 9 }, { name: 'Volt Tackle', pp: 8, maxPp: 24, type: 14 },
];
const baseView = (over = {}) => ({
  env: 0,
  foe: mon({ species: 1, name: 'Bulbasaur', level: 50, hp: 120, maxHp: 120 }),
  player: mon({ species: 25, name: 'Pikachu', level: 50, gender: 'F', hp: 110, maxHp: 110, exp: { into: 1000, span: 3000 } }),
  box: { mode: 'action', prompt: ['What will', 'Pikachu do?'], cursor: 0 },
  ...over,
});
const cloneView = (v) => JSON.parse(JSON.stringify(v));

/* ================================================================== 3. golden frames */

const frames = [];                                    // { name, frame }
const addFrame = (name, view, uiOverride) => { frames.push({ name, frame: (uiOverride || ui).render(view) }); };
for (let c = 0; c < 4; c++) addFrame('action.cursor' + c, baseView({ box: { mode: 'action', prompt: ['What will', 'Pikachu do?'], cursor: c } }));
for (let c = 0; c < 4; c++) addFrame('moves.cursor' + c, baseView({ box: { mode: 'moves', cursor: c, moves: MOVES } }));
addFrame('message.text', baseView({ box: { mode: 'message', text: ['Wild Bulbasaur appeared!', ''], arrow: false } }));
addFrame('message.arrow', baseView({ box: { mode: 'message', text: ['Pikachu used THUNDERBOLT!', "It's super effective!"], arrow: true } }));
for (let e = 0; e < B.ENV_COUNT; e++) addFrame('env.' + e, baseView({ env: e, box: { mode: 'message', text: ['Wild Bulbasaur appeared!', ''] } }));
for (const hp of [120, 72, 61, 59, 25, 24, 23, 11, 10, 9, 1, 0]) {
  const v = baseView({ box: { mode: 'message', text: ['', ''] } }); v.foe.hp = hp; v.player.hp = Math.max(0, Math.round(hp * 110 / 120)); addFrame('hp.' + hp, v);
}
for (const st of ['PSN', 'PAR', 'SLP', 'FRZ', 'BRN']) { const v = baseView({ box: { mode: 'message', text: ['', ''] } }); v.foe.status = st; v.player.status = st; addFrame('status.' + st, v); }
{ const v = baseView({ box: { mode: 'message', text: ['', ''] } }); v.foe.gender = 'F'; v.player.gender = null; v.foe.shiny = true; addFrame('gender.foeF.playerNone.foeShiny', v); }
for (const drop of [0, 16, 32, 48, 63]) { const v = baseView({ box: { mode: 'message', text: ['', ''] } }); v.foe.drop = drop; addFrame('faint.drop' + drop, v); }
for (const into of [0, 750, 1500, 2999, 3000]) { const v = baseView({ box: { mode: 'message', text: ['', ''] } }); v.player.exp = { into, span: 3000 }; addFrame('exp.' + into, v); }
for (const sp of [4, 7, 150, 249, 384]) { const v = baseView({ box: { mode: 'message', text: ['', ''] } }); const g = S.speciesGfx(rom, sp); v.foe = mon({ species: sp, name: g.name, level: 50, hp: 100, maxHp: 100 }); v.player = mon({ species: sp === 7 ? 4 : 7, name: S.speciesGfx(rom, sp === 7 ? 4 : 7).name, level: 50, hp: 100, maxHp: 100, exp: { into: 10, span: 100 } }); addFrame('species.' + sp, v); }
// S1 screens: party (selected / fainted / active / statuses / cancel selected), team preview, result, weather tags
const fid = (name) => pack.species.findIndex((x) => x && x.name === name);
const SCR_IDS = ['Impidimp', 'Whirlipede', 'Linoone', 'Lucario', 'Genesect', 'Pikachu'].map(fid);
const smon = (i, o = {}) => ({ species: SCR_IDS[i], name: pack.species[SCR_IDS[i]].name, level: 50, gender: i % 2 ? 'F' : 'M', hp: 100, maxHp: 152, status: null, fainted: false, active: false, shiny: false, ...o });
const partyView = (cursor, cancelSel) => ({ screen: 'party', party: { mons: [smon(0, { hp: 0, fainted: true }), smon(1, { hp: 115, maxHp: 115 }), smon(2, { hp: 60, status: 'PSN' }), smon(3, { active: true, hp: 152 }), smon(4, { hp: 30 }), smon(5, { status: 'BRN' })], cursor, tick: 0, canCancel: true, cancelSel, prompt: ['Choose a', 'Pokemon.'] } });
const previewView = (cursor, picks) => ({ screen: 'preview', preview: { mine: [0, 1, 2, 3, 4, 5].map((i) => smon(i)), foe: [5, 4, 3, 2, 1, 0].map((i) => smon(i)), picks, cursor, tick: 0, title: 'Choose 3', foeTitle: 'CPU Normal', prompt: [] } });
const resultView = (cursor) => ({ screen: 'result', result: { head: ['You lost to CPU Normal!'], mine: [smon(0, { fainted: true }), smon(1, { fainted: true }), smon(2)], foe: [smon(3), smon(4, { fainted: true }), smon(5)], options: ['REMATCH', 'NEW BATTLE', 'LEAVE'], cursor, tick: 0, mineLabel: 'YOU', foeLabel: 'CPU NORMAL' } });
for (const c of [0, 1, 5]) addFrame('screen.party.cursor' + c, partyView(c, false));
addFrame('screen.party.cancelSel', partyView(5, true));
addFrame('screen.preview.picks', previewView(1, [2, 0]));
addFrame('screen.preview.none', previewView(0, []));
for (const c of [0, 1, 2]) addFrame('screen.result.cursor' + c, resultView(c));
{ const v = baseView({ box: { mode: 'message', text: ['', ''] } }); v.tags = ['RAIN']; addFrame('tags.rain', v); v.tags = ['TRICK ROOM', 'SUN']; addFrame('tags.trickroom.sun', v); }
addFrame('moves.longnames', baseView({ box: { mode: 'moves', cursor: 0, moves: [{ name: 'Stomping Tantrum', pp: 10, maxPp: 10, type: 5 }, { name: 'Dazzling Gleam', pp: 10, maxPp: 10, type: 19 }, { name: 'Soul-Stealing 7-Star Strike', pp: 5, maxPp: 5, type: 8 }, { name: 'Menacing Moonraze Maelstrom', pp: 5, maxPp: 5, type: 8 }] } }));
ok(frames.every((f) => f.frame.width === 240 && f.frame.height === 160 && f.frame.rgba.length === 240 * 160 * 4), '3. every frame is 240x160 RGBA');

// a scripted battle through the real state machine
function scriptedBattle(opts = {}) {
  const demo = new B.ScriptedBattle(ui, pack, { player: 25, foe: 1, level: 50, env: 0, ...opts });
  const out = [];
  const snap = (name) => out.push({ name, frame: ui.render(demo.view()), dbg: demo.debug() });
  demo.settle(); snap('intro.done');
  demo.press('right'); snap('action.right'); demo.press('down'); snap('action.rightdown'); demo.press('left'); demo.press('up');
  demo.press('a'); snap('moves.open');
  demo.press('right'); demo.press('left'); demo.press('a');
  let n = 0, k = 0;
  while (demo.phase === 'steps' && n < 6000) { demo.tick(); n++; if (n % 45 === 0 && k < 40) { snap('turn1.f' + n); k++; } }
  snap('turn1.end');
  return { demo, out, frames: n };
}
const sc = scriptedBattle();
for (const s of sc.out) frames.push({ name: 'script.' + s.name, frame: s.frame });
ok(sc.demo.phase === 'action', '3. the scripted turn ends back at the action menu', sc.demo.phase);

const hashes = {};
for (const f of frames) hashes[f.name] = hashFrame(f.frame);
// hash pins of the ROM party-menu art (decoded bytes; hashes only)
const partyArtHashes = () => {
  const A = B.PARTY_ART, tiles = GC.smolDecode(rom, A.tiles).data, tm = GC.smolTilemapDecode(rom, A.tilemap).entries, pal = GC.readPalette(rom, A.palette, 256);
  return { tiles: sha1(tiles), tilemap: sha1(new Uint8Array(tm.buffer, tm.byteOffset, tm.byteLength)), palette: sha1(new Uint8Array(pal.buffer, pal.byteOffset, pal.byteLength)), tileCount: tiles.length / 32 };
};
const goldenDoc = { schema: 2, art: partyArtHashes(), rom: U.ROM_SHA256, note: 'SHA-1 of the RGBA bytes of each rendered 240x160 frame. Hashes only: nothing ROM-derived (no pixels) is stored here. Regenerate with ARENA_UPDATE_GOLDEN=1 node tools/pokemonarena_battle_ui_test.mjs after an intentional change.', count: frames.length, frames: hashes };
if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify(goldenDoc, null, 1) + '\n'); console.log('golden written:', GOLDEN, frames.length, 'frames'); }
{
  let gold = null;
  try { gold = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch (e) { ok(false, '3. golden file readable', String(e.message)); }
  if (gold) {
    ok(gold.rom === U.ROM_SHA256, '3. golden is for the pinned ROM');
    { const a = partyArtHashes(); ok(gold.art && gold.art.tiles === a.tiles && gold.art.tilemap === a.tilemap && gold.art.palette === a.palette && gold.art.tileCount === a.tileCount, '3. the decoded ROM party-menu art (tiles / tilemap / palette) equals the pinned hashes', JSON.stringify(a));
      const bad = { ...a, tiles: '0'.repeat(40) }; ok(!(gold.art && gold.art.tiles === bad.tiles), '3. a wrong art pin is detected (negative control)'); }
    ok(Object.keys(gold.frames).length === frames.length, '3. golden has one hash per rendered frame', Object.keys(gold.frames).length + ' vs ' + frames.length);
    let bad = 0; const badNames = [];
    for (const f of frames) if (gold.frames[f.name] !== hashes[f.name]) { bad++; badNames.push(f.name); }
    ok(bad === 0, '3. all ' + frames.length + ' frame hashes equal the golden', bad + ' differ: ' + badNames.slice(0, 5).join(','));
    // the comparison itself can fail: tamper one hash in a copy and it must be reported
    const tampered = JSON.parse(JSON.stringify(gold)); const k0 = Object.keys(tampered.frames)[0]; tampered.frames[k0] = '0'.repeat(40);
    ok(frames.filter((f) => tampered.frames[f.name] !== hashes[f.name]).length === 1, '3. a tampered golden entry is detected (negative control)');
    const distinct = new Set(Object.values(hashes));
    ok(distinct.size >= frames.length - 8, '3. frames are mostly distinct (the hash is not blind)', distinct.size + ' distinct of ' + frames.length);
  }
}
// PNG strips for human inspection
{
  const pick = (names, file, cols, k = 2) => {
    const items = names.map((n) => frames.find((f) => f.name === n)).filter(Boolean);
    const cw = 240 * k, ch = 160 * k, rows = Math.ceil(items.length / cols), pad = 4;
    const c = newCanvas(cols * (cw + pad) + pad, rows * (ch + pad) + pad, [20, 20, 28, 255]);
    items.forEach((it, i) => { const s = scaleRGBA(240, 160, it.frame.rgba, k); blit(c, pad + (i % cols) * (cw + pad), pad + Math.floor(i / cols) * (ch + pad), s.width, s.height, s.rgba); });
    writePNG(path.join(OUT, file), c.width, c.height, c.rgba);
  };
  pick(['action.cursor0', 'action.cursor3', 'moves.cursor0', 'moves.cursor3', 'message.arrow', 'hp.1'], 'battle_menus.png', 2);
  pick(['hp.120', 'hp.72', 'hp.61', 'hp.25', 'hp.9', 'hp.0'], 'battle_hp_sweep.png', 2);
  pick(['env.0', 'env.2', 'env.3', 'env.4', 'env.6', 'env.7', 'env.8', 'env.9', 'env.13', 'env.17', 'env.20', 'env.22'], 'battle_envs.png', 3, 1);
  pick(['status.PSN', 'status.BRN', 'gender.foeF.playerNone.foeShiny', 'faint.drop32', 'faint.drop63', 'exp.2999'], 'battle_misc.png', 2);
  pick(['screen.party.cursor1', 'screen.party.cancelSel', 'screen.preview.picks', 'screen.result.cursor1', 'tags.trickroom.sun', 'moves.longnames'], 'battle_s1_screens.png', 2);
  pick(sc.out.filter((_, i) => i % 3 === 0).slice(0, 12).map((s) => 'script.' + s.name), 'battle_scripted.png', 3, 1);
}

/* ================================================================== 4. provenance: the pixels come from the ROM */

const copyRom = () => { const c = new Uint8Array(rom.length); c.set(rom); return c; };
const renderWith = (r, view) => { const u2 = B.createBattleUi(r); return u2.render(view); };
const cnt = (frame, x0, y0, w, h, pred) => { let n = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = (y * 240 + x) * 4; if (pred(frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2])) n++; } return n; };
const eq = (a, b, c) => (p, q, r) => p === a && q === b && r === c;
const msgView = () => baseView({ box: { mode: 'message', text: ['Wild Bulbasaur appeared!', 'It is a test.'] } });
{
  const L = B.LAYOUT, base = ui.render(baseView({ box: { mode: 'message', text: ['', ''] } }));
  const twin = renderWith(copyRom(), baseView({ box: { mode: 'message', text: ['', ''] } }));
  ok(hashFrame(base) === hashFrame(twin), '4. an unmutated ROM copy renders byte-identically (twin)');
  const hpPal = ui.assets.get('healthbox.hpGreen').palette;
  const rgb15 = (v) => [((v & 31) << 3) | ((v & 31) >> 2), (((v >> 5) & 31) << 3) | (((v >> 5) & 31) >> 2), (((v >> 10) & 31) << 3) | (((v >> 10) & 31) >> 2)];
  const GREEN = rgb15(hpPal[10]), LGREEN = rgb15(hpPal[11]), YEL = rgb15(hpPal[12]), RED = rgb15(hpPal[14]), RED2 = rgb15(hpPal[15]);
  const bx = L.foeBoxTL[0] + L.foe.barX, by = L.foeBoxTL[1] + L.foe.barY;
  const isGreen = (r, g, b) => (r === GREEN[0] && g === GREEN[1] && b === GREEN[2]) || (r === LGREEN[0] && g === LGREEN[1] && b === LGREEN[2]);
  const nG = cnt(base, bx, by, 48, 8, isGreen);
  ok(nG > 90, '4. HP bar: a full green bar has green fill pixels in the bar rectangle', 'green px ' + nG);
  // zero the 9 green bar tiles (0x7202e0..+288): the bar must vanish
  { const r = copyRom(); r.fill(0, 0x7202e0, 0x7202e0 + 288);
    const f = renderWith(r, baseView({ box: { mode: 'message', text: ['', ''] } }));
    ok(cnt(f, bx, by, 48, 8, isGreen) === 0, '4. HP bar: zeroing the ROM green-bar tiles removes every green pixel (the bar disappears)', 'green px after ' + cnt(f, bx, by, 48, 8, isGreen));
    ok(hashFrame(f) !== hashFrame(base), '4. HP bar: zeroed tiles change the frame'); }
  // yellow and red strips
  for (const [name, off, hp, want] of [['yellow', 0x7208c0, 40, [YEL]], ['red', 0x7209e0, 8, [RED, RED2]]]) {
    const v = baseView({ box: { mode: 'message', text: ['', ''] } }); v.foe.hp = hp;
    const f0 = ui.render(v);
    const is = (r, g, b) => want.some((c) => r === c[0] && g === c[1] && b === c[2]);
    const n0 = cnt(f0, bx, by, 48, 8, is);
    const r = copyRom(); r.fill(0, off, off + 288);
    const f1 = renderWith(r, v);
    ok(n0 > 0 && cnt(f1, bx, by, 48, 8, is) === 0, '4. HP bar: zeroing the ROM ' + name + '-bar tiles removes the ' + name + ' fill', n0 + ' -> ' + cnt(f1, bx, by, 48, 8, is));
  }
  // exp bar tiles
  { const f0 = ui.render(baseView({ box: { mode: 'message', text: ['', ''] } }));
    const r = copyRom(); r.fill(0, 0x720400, 0x720400 + 288); const f1 = renderWith(r, baseView({ box: { mode: 'message', text: ['', ''] } }));
    ok(hashFrame(f0) !== hashFrame(f1), '4. EXP bar: zeroing the ROM EXP-bar tiles changes the frame'); }
  // font glyph bytes: zero the whole 'normal' glyph array (512 glyphs x 64 B at 0x60df24)
  { const dark = eq(24, 24, 24), f0 = ui.render(msgView());
    const n0 = cnt(f0, 16, 120, 208, 32, dark);
    const r = copyRom(); r.fill(0, 0x60df24, 0x60df24 + 512 * 64);
    const f1 = renderWith(r, msgView());
    const n1 = cnt(f1, 16, 120, 208, 32, dark);
    ok(n0 > 150 && n1 === 0, '4. font: zeroing the ROM glyph bytes removes every text pixel from the message window', n0 + ' -> ' + n1);
    // and the width table (0x200 bytes before the glyphs): glyph advance 0 piles every glyph on the first pixel
    const r2 = copyRom(); r2.fill(0, 0x60df24 - 0x200, 0x60df24);
    const f2 = renderWith(r2, msgView());
    ok(hashFrame(f2) !== hashFrame(f0) && cnt(f2, 16, 120, 208, 32, dark) !== n0, '4. font: zeroing the ROM width table corrupts the text layout');
    // text colour palette entry 12 (ROM 0x6cd02c + 24): the dark text colour comes from the ROM
    const r3 = copyRom(); r3[0x6cd02c + 24] = 0x1f; r3[0x6cd02c + 25] = 0x00;
    const f3 = renderWith(r3, msgView());
    ok(cnt(f3, 16, 120, 208, 32, eq(24, 24, 24)) === 0 && cnt(f3, 16, 120, 208, 32, eq(255, 0, 0)) > 100, '4. text colour: editing ROM palette entry 12 recolours the message text');
    // the small font (healthbox name) too
    const r4 = copyRom(); r4.fill(0, 0x626524, 0x626524 + 512 * 64);
    const f4 = renderWith(r4, msgView());
    ok(hashFrame(f4) !== hashFrame(f0), '4. font: zeroing the ROM small-font glyphs changes the healthbox text'); }
  // compressed / structured assets: corrupt bytes inside the blob. Either the decoder throws (good: it read the ROM) or the output changes.
  function corrupt(name, offsets, view = msgView()) {
    const r = copyRom(); for (const o of offsets) r[o] ^= 0xff;
    let changed;
    try { const f = renderWith(r, view); changed = hashFrame(f) !== hashFrame(ui.render(view)); } catch (e) { changed = true; }
    ok(changed, '4. ' + name + ': corrupting the ROM bytes changes the output (or the decoder rejects them)');
  }
  const word = (o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
  const envRec = 0x430498;
  corrupt('terrain tiles', [word(envRec + 8) - 0x08000000 + 40, word(envRec + 8) - 0x08000000 + 41, word(envRec + 8) - 0x08000000 + 60]);
  { const r = copyRom(); const p = word(envRec + 16) - 0x08000000; r[p] ^= 0xff; r[p + 1] ^= 0xff; r[p + 2] ^= 0xff; const f = renderWith(r, msgView()); ok(hashFrame(f) !== hashFrame(ui.render(msgView())), '4. terrain palette: editing the ROM palette recolours the scene'); }
  { const rec = S.speciesRecord(rom, 25);
    // (a female Pikachu uses the female pictures, so this view is a male one)
    const maleView = () => { const v = msgView(); v.player.gender = 'M'; return v; };
    corrupt('player back sprite', [rec.back + 20, rec.back + 21, rec.back + 22, rec.back + 23], maleView());
    corrupt('foe front sprite', [S.speciesRecord(rom, 1).front + 20, S.speciesRecord(rom, 1).front + 21, S.speciesRecord(rom, 1).front + 22]);
    const r = copyRom(); const p = rec.pal; r[p + 8] ^= 0xff; r[p + 9] ^= 0xff; r[p + 10] ^= 0xff; const f = renderWith(r, maleView());
    ok(hashFrame(f) !== hashFrame(ui.render(maleView())), '4. sprite palette: editing the ROM species palette recolours the sprite'); }
  corrupt('healthbox frame art (singles player)', [0x716f38 + 40, 0x716f38 + 41, 0x716f38 + 60]);
  corrupt('healthbox frame art (singles opponent)', [0x716e68 + 40, 0x716e68 + 41, 0x716e68 + 60]);
  corrupt('textbox frame tiles', [0x73a170 + 30, 0x73a170 + 31, 0x73a170 + 50]);
  corrupt('textbox tilemap', [0x73a09c + 12, 0x73a09c + 13, 0x73a09c + 20], baseView());
  // FA1: the move menu no longer draws a type badge (the real game prints the type's NAME); these are the ROM sources the battle screen reads instead
  corrupt('PP colour table (ROM 0x6cd00c, the normal pair)', [0x6cd018, 0x6cd019], baseView({ box: { mode: 'moves', cursor: 0, moves: MOVES } }));
  corrupt('window frame palette (ROM 0x111b8d8)', [0x111b8d8 + 6, 0x111b8d8 + 7, 0x111b8d8 + 10], baseView({ box: { mode: 'action', prompt: ['What will', 'Pikachu do?'], cursor: 0 } }));
  corrupt('window frame tiles (ROM 0x111d218)', [0x111d218 + 40, 0x111d218 + 41, 0x111d218 + 60], baseView({ box: { mode: 'action', prompt: ['What will', 'Pikachu do?'], cursor: 0 } }));
  corrupt('action menu string (ROM 0x43cf54)', [0x43cf54, 0x43cf55], baseView({ box: { mode: 'action', prompt: ['What will', 'Pikachu do?'], cursor: 0 } }));
  corrupt('text arrow tile (ROM 0xf2c688)', [0xf2c688, 0xf2c689, 0xf2c68a, 0xf2c68b], baseView({ box: { mode: 'message', text: ['Hello', ''], arrow: true, tick: 0 } }));
  corrupt('foe shadow sheet (ROM 0x6c6f48)', [0x6c6f48 + 16, 0x6c6f48 + 17, 0x6c6f48 + 18, 0x6c6f48 + 19], baseView({ box: { mode: 'message', text: ['', ''] } }));
  // the healthbox status label is the ROM's own 24x8 tile strip (foe = strip 2 @0x720bc0, player = strip 1 @0x720520), PSN = elements 0..2
  corrupt('foe status label strip (PSN, healthbox.status2)', [0x720bc0 + 36, 0x720bc0 + 37, 0x720bc0 + 70], baseView({ box: { mode: 'message', text: ['', ''] }, foe: mon({ species: 1, name: 'Bulbasaur', level: 50, hp: 120, maxHp: 120, status: 'PSN' }) }));
  corrupt('player status label strip (PSN, healthbox.status1)', [0x720520 + 36, 0x720520 + 37, 0x720520 + 70], baseView({ box: { mode: 'message', text: ['', ''] }, player: mon({ species: 25, name: 'Pikachu', level: 50, hp: 110, maxHp: 110, status: 'PSN', exp: { into: 1, span: 10 } }) }));
  // the 'HP' label: zero its three source tiles and its orange ink must disappear from the frame
  { const hpPal2 = ui.assets.get('healthbox.hpLabel').palette, orange = rgb15(hpPal2[12]);
    const isO = (r, g, b) => r === orange[0] && g === orange[1] && b === orange[2];
    const lx = L.foeBoxTL[0] + L.foe.labelX, ly = L.foeBoxTL[1] + L.foe.labelY;
    const n0 = cnt(base, lx, ly, 16, 8, isO);
    const r = copyRom(); r.fill(0, 0x7202a0, 0x7202a0 + 96);
    const n1 = cnt(renderWith(r, baseView({ box: { mode: 'message', text: ['', ''] } })), lx, ly, 16, 8, isO);
    ok(n0 > 25 && n1 === 0, '4. HP label: zeroing the ROM label tiles removes its orange ink', n0 + ' -> ' + n1); }
  corrupt('window template table (text window rectangles)', [0x430278 + 1, 0x430278 + 3], msgView());
}

/* ================================================================== 5. the demo battle */

function runTurnTrace(demo) {
  const trace = [];
  let n = 0;
  while (demo.phase === 'steps' && n < 20000) { const before = demo.foe.hp, pb = demo.player.hp; demo.tick(); n++; trace.push({ f: demo.foe.hp, p: demo.player.hp, df: before - demo.foe.hp, dp: pb - demo.player.hp, step: demo.cur ? demo.cur.t : null }); }
  return trace;
}
{
  const mk = () => new B.ScriptedBattle(ui, pack, { player: 25, foe: 1, level: 50, env: 0 });
  const a = mk(), b = mk();
  a.settle(); b.settle();
  ok(a.phase === 'action' && a.view().box.mode === 'action', '5. the intro messages end at the action menu');
  ok(a.view().box.prompt[0] === 'What will' && a.view().box.prompt[1] === 'Pikachu do?', '5. the prompt reads "What will Pikachu do?" with the ROM species name', JSON.stringify(a.view().box.prompt));
  // cursor / arrows
  ok(a.cursor === 0, '5. cursor starts on FIGHT');
  a.press('right'); ok(a.cursor === 1, '5. right moves FIGHT -> BAG');
  a.press('down'); ok(a.cursor === 3, '5. down moves BAG -> RUN');
  a.press('left'); ok(a.cursor === 2, '5. left moves RUN -> POKeMON');
  a.press('up'); ok(a.cursor === 0, '5. up moves POKeMON -> FIGHT');
  a.press('up'); ok(a.cursor === 2, '5. up/down toggle the row (no off-grid positions)');
  a.press('up'); ok(a.cursor === 0, '5. up again returns');
  a.press('a'); ok(a.phase === 'moves' && a.view().box.mode === 'moves', '5. A on FIGHT opens the move menu');
  ok(a.view().box.moves.length === 4 && a.view().box.moves.every((m) => m.name && m.maxPp > 0), '5. the move menu has four ROM moves with PP', JSON.stringify(a.view().box.moves.map((m) => m.name + ' ' + m.pp + '/' + m.maxPp)));
  a.press('down'); ok(a.moveCursor === 2, '5. down moves the move cursor');
  a.press('b'); ok(a.phase === 'action', '5. B leaves the move menu');
  a.press('a'); a.press('right'); a.press('a');                         // Slam
  b.settle(); b.press('a'); b.press('right'); b.press('a');
  const ta = runTurnTrace(a), tb = runTurnTrace(b);
  ok(ta.length === tb.length && ta.every((x, i) => x.f === tb[i].f && x.p === tb[i].p), '5. two identical runs produce identical HP traces (deterministic)');
  ok(a.phase === 'action' && b.phase === 'action', '5. the turn ends back at the action menu');
  // drain semantics
  const foeSteps = ta.filter((x) => x.df !== 0), plSteps = ta.filter((x) => x.dp !== 0);
  // FA1: the ROM drains maxHP/24 HP a frame (ScriptedBattle uses battle_ui.drainFrames): every step is that size except the last, which lands on the target
  const stepOf = (max) => B.hpBarToAdd(max);
  ok(foeSteps.length > 0 && foeSteps.slice(0, -1).every((x) => x.df === stepOf(a.foe.maxHp)) && foeSteps[foeSteps.length - 1].df <= stepOf(a.foe.maxHp), '5. the foe HP drains maxHP/24 per frame', 'steps ' + foeSteps.length + ' ' + new Set(foeSteps.map((x) => x.df)).size);
  ok(plSteps.length > 0 && plSteps.slice(0, -1).every((x) => x.dp === stepOf(a.player.maxHp)), '5. the player HP drains maxHP/24 per frame (foe retaliation)');
  ok(ta.every((x, i) => i === 0 || (x.f <= ta[i - 1].f && x.p <= ta[i - 1].p)), '5. HP never rises during the exchange (monotonic)');
  { // expected damage from the formula, computed from the pack
    const ref = new B.ScriptedBattle(ui, pack, { player: 25, foe: 1, level: 50 });
    const mv = ref.player.moves[1];
    const dmg = B.damageOf(pack, ref.player, ref.foe, mv);
    ok(foeSteps.length === Math.ceil(dmg / stepOf(a.foe.maxHp)) && foeSteps.reduce((s, x) => s + x.df, 0) === dmg, '5. the foe lost exactly damageOf() HP (' + dmg + ') for ' + mv.name + ' in ceil(dmg / step) frames', 'steps ' + foeSteps.length + ' dmg ' + dmg);
    ok(a.foe.maxHp - a.foe.hp === dmg, '5. the foe HP after the turn is maxHp - damage');
  }
  // damage formula worked example, by hand: L50, power 90, A=70, D=70 -> floor(floor(22*90*70/70)/50)+2 = 41; STAB x1.5 = 61; x2 effective = 122
  { const atk = { level: 50, stats: { atk: 70, spa: 70 }, types: [14, 14] }, def = { stats: { def: 70, spd: 70 }, types: [12, 12] };
    const mv = { power: 90, category: 1, type: 14 };
    ok(B.damageOf(pack, atk, def, mv) === 122, '5. damageOf: L50 power-90 Electric STAB vs a Water mon = 122 (hand-computed)', String(B.damageOf(pack, atk, def, mv)));
    ok(B.damageOf(pack, { ...atk, types: [1, 1] }, def, mv) === 82, '5. damageOf: without STAB = 82');
    ok(B.damageOf(pack, atk, { ...def, types: [5, 5] }, mv) === 0, '5. damageOf: Electric vs Ground = 0 (immune, from the ROM type chart)');
    ok(B.damageOf(pack, atk, { ...def, types: [13, 13] }, mv) === 30, '5. damageOf: Electric vs Grass = 30 (resisted)', String(B.damageOf(pack, atk, { ...def, types: [13, 13] }, mv))); }
  // a full battle until someone faints, then the reset
  { const d = new B.ScriptedBattle(ui, pack, { player: 25, foe: 7, level: 50 });
    d.settle(); d.press('a'); d.press('a');                              // Thunderbolt: super effective vs Squirtle
    const seen = []; let n = 0, wasHidden = false;
    while (n < 40000) {
      d.tick(); n++;
      if (d.cur && d.cur.t === 'text') for (const p of d.cur.tw.pages) for (const l of p) if (l && !seen.includes(l)) seen.push(l);
      if (!d.foe.visible) wasHidden = true;
      if (d.phase === 'action' && wasHidden) break;
      if (d.phase === 'action' && n > 30) { d.press('a'); d.press('a'); }
    }
    ok(seen.some((s) => /super effective/.test(s)), '5. a super-effective hit prints "It\'s super effective!"', seen.join(' | ').slice(0, 200));
    ok(wasHidden, '5. a fainted foe is hidden after the sink animation');
    ok(seen.some((s) => /fainted/.test(s)) && seen.some((s) => /EXP\. Points/.test(s)), '5. faint + EXP messages appear');
    ok(d.foe.hp === d.foe.maxHp && d.foe.visible && d.player.hp > 0, '5. after a finished battle the demo resets to full HP', d.foe.hp + '/' + d.foe.maxHp);
  }
  // sprite sink: the fainting sprite is cut off at its original bottom edge
  { const v0 = baseView({ box: { mode: 'message', text: ['', ''] } }), v1 = cloneView(v0); v1.foe.drop = 63;
    const f0 = ui.render(v0), f1 = ui.render(v1);
    ok(hashFrame(f0) !== hashFrame(f1), '5. a sunken foe sprite renders differently');
  }
  // typewriter in the renderer: partial text shows fewer text pixels than the full line
  { const dark = eq(24, 24, 24);
    const part = ui.render(baseView({ box: { mode: 'message', text: ['Wild Bul', ''] } })), full = ui.render(baseView({ box: { mode: 'message', text: ['Wild Bulbasaur appeared!', ''] } }));
    ok(cnt(part, 16, 120, 208, 32, dark) < cnt(full, 16, 120, 208, 32, dark), '5. a partially typed line draws fewer text pixels than the full line'); }
  // the RUN option
  { const d = new B.ScriptedBattle(ui, pack, { player: 25, foe: 1, level: 50 }); d.settle(); d.press('down'); d.press('right'); d.press('a'); let n = 0; const seen = []; while (n++ < 3000 && d.phase !== 'action') { d.tick(); if (d.cur && d.cur.t === 'text') seen.push(d.cur.tw.pages[0][0]); if (seen.some((s) => /Got away/.test(s))) break; } ok(seen.some((s) => /Got away safely!/.test(s)), '5. RUN prints "Got away safely!"'); }
}

/* ================================================================== 6. purity */
{
  const files = ['battle_ui.js', 'textfx.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, 'pokemonarena', 'js', f), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [pat, what] of [[/from\s+['"]node:/, 'node: import'], [/\bBuffer\b/, 'Buffer'], [/\brequire\s*\(/, 'require('], [/\bdocument\b/, 'document'], [/\bwindow\b/, 'window'], [/Math\.random\s*\(/, 'Math.random()'], [/\bDate\b/, 'Date'], [/performance\.now/, 'performance.now']]) {
      ok(!pat.test(src), '6. ' + f + ' has no ' + what);
    }
  }
  const mutantSrc = 'const x = Math.random();';
  ok(/Math\.random\s*\(/.test(mutantSrc), '6. the purity pattern itself fires on a mutant line (negative control)');
}

/* ================================================================== 7. healthbox geometry, level cap, fits, hostile views, faint timing */

// ---- source mutants: a patched COPY of pokemonarena/js in a temp dir, imported fresh ------------------------------
const jsDir = path.join(root, 'pokemonarena', 'js');
const tmpDirs = [];
async function mutantModule(patches) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mut-'));
  tmpDirs.push(dir);
  for (const f of fs.readdirSync(jsDir)) fs.copyFileSync(path.join(jsDir, f), path.join(dir, f));
  let src = fs.readFileSync(path.join(dir, 'battle_ui.js'), 'utf8');
  for (const [a, b] of patches) { if (!src.includes(a)) throw new Error('mutant patch does not apply: ' + a.slice(0, 60)); src = src.split(a).join(b); }
  fs.writeFileSync(path.join(dir, 'battle_ui.js'), src);
  return import(pathToFileURL(path.join(dir, 'battle_ui.js')).href);
}
const legalIds = pack.species.map((s, i) => (s && s.legal ? i : -1)).filter((i) => i >= 0);
const rgb15 = (v) => [((v & 31) << 3) | ((v & 31) >> 2), (((v >> 5) & 31) << 3) | (((v >> 5) & 31) >> 2), (((v >> 10) & 31) << 3) | (((v >> 10) & 31) >> 2)];

// ---- 7a. geometry: measured from the decoded frame art, no layout number is trusted ---------------------------------
const lumA = (art, x, y) => { const o = (y * art.width + x) * 4; return art.rgba[o + 3] === 0 ? -1 : (art.rgba[o] + art.rgba[o + 1] + art.rgba[o + 2]) / 3; };
const isDark = (art, x, y) => { const v = lumA(art, x, y); return v >= 0 && v < 90; };
function geometryFindings(layout, artOf) {
  const f = [], t = (n, c) => { if (!c) f.push(n); };
  for (const [side, artSide, lo, hi] of [['foe', 'opponent', 76, 100], ['player', 'player', 84, 100]]) {
    const art = artOf(artSide), Ls = layout[side];
    let cap = -1;
    for (let x = lo; x < hi; x++) if ([18, 19, 20, 21].every((y) => isDark(art, x, y) && !isDark(art, x - 1, y)) && lumA(art, x, 17) > 90 && lumA(art, x, 22) > 90 && !isDark(art, x, 16)) { cap = x; break; }
    t(side + ': the frame has a 6-row HP-bar end cap in rows 17..22 (found x=' + cap + ')', cap > 0);
    t(side + ': barX + 48 px ends exactly where the frame cap is (barX ' + Ls.barX + ' + 48 vs cap ' + cap + ')', Ls.barX + 48 === cap);
    t(side + ': barY is the cap top row 17 (barY ' + Ls.barY + ')', Ls.barY === 17);
    t(side + ': the 16 px HP label ends where the bar begins and shares its row', Ls.labelX + 16 === Ls.barX && Ls.labelY === Ls.barY);
  }
  { const art = artOf('player'); let x0 = -1, x1 = -1;
    for (let x = 20; x < 110; x++) { const rec = isDark(art, x, 34) && isDark(art, x, 37) && lumA(art, x, 35) > 90 && lumA(art, x, 36) > 90; if (rec) { if (x0 < 0) x0 = x; x1 = x; } }
    const Ls = layout.player;
    t('player: the frame has an EXP recess 64 px wide (x ' + x0 + '..' + x1 + ')', x1 - x0 + 1 === 64);
    t('player: expX is the recess left edge (expX ' + Ls.expX + ' vs ' + x0 + ')', Ls.expX === x0);
    t('player: the EXP element rows 2 and 5 (its dark border) land on the frame lines y=34 and y=37 (expY ' + Ls.expY + ')', Ls.expY + 2 === 34 && Ls.expY + 5 === 37); }
  return f;
}
{
  const artOf = (s) => ui.healthboxArt(s);
  const real = geometryFindings(B.LAYOUT, artOf), twin = geometryFindings(B.LAYOUT, artOf);
  ok(real.length === 0, '7a. healthbox geometry: LAYOUT agrees with the decoded frame art (cap, label, bar, EXP recess)', real.slice(0, 4).join('; '));
  ok(twin.length === 0, '7a. unmutated twin stays quiet');
  const withL = (side, patch) => ({ ...B.LAYOUT, [side]: { ...B.LAYOUT[side], ...patch } });
  const muts = {
    'foe barX 41 (the shipped off-by-one)': withL('foe', { barX: 41, labelX: 25 }), 'foe barX 39': withL('foe', { barX: 39, labelX: 23 }),
    'player barX 49': withL('player', { barX: 49, labelX: 33 }), 'bar row 14 (the flat-tile era)': withL('foe', { barY: 14, labelY: 14 }),
    'bar row 18': withL('player', { barY: 18, labelY: 18 }), 'label overlaps the bar': withL('foe', { labelX: 28 }),
    'EXP x 36 (shipped)': withL('player', { expX: 36 }), 'EXP y 31': withL('player', { expY: 31 }), 'EXP y 33': withL('player', { expY: 33 }),
  };
  for (const [n, lay] of Object.entries(muts)) { const r = geometryFindings(lay, artOf); ok(r.length > 0, '7a. geometry mutant "' + n + '" is caught', r.length ? r[0] : 'NOT CAUGHT'); }
  // the rendered bar is the 7-row block: dark, dark, fill, fill, dark, dark, shadow, with a dark cap on its right
  const pal = ui.assets.get('healthbox.hpGreen').palette, rgb = (i) => rgb15(pal[i]);
  const f0 = ui.render(baseView({ box: { mode: 'message', text: ['', ''] } }));
  const px = (x, y) => { const o = (y * 240 + x) * 4; return [f0.rgba[o], f0.rgba[o + 1], f0.rgba[o + 2]]; };
  const bxx = B.LAYOUT.foeBoxTL[0] + B.LAYOUT.foe.barX + 20, byy = B.LAYOUT.foeBoxTL[1] + B.LAYOUT.foe.barY;
  const want = [1, 1, 10, 11, 1, 1, 3].map(rgb);
  const got = [0, 1, 2, 3, 4, 5, 6].map((r) => px(bxx, byy + r));
  ok(want.every((w, i) => w[0] === got[i][0] && w[1] === got[i][1] && w[2] === got[i][2]), '7a. a full green bar renders as dark,dark,fill,fill,dark,dark,shadow (a border above AND below the fill)', JSON.stringify(got));
  const capPx = px(B.LAYOUT.foeBoxTL[0] + B.LAYOUT.foe.barX + 48, byy + 2);
  ok(capPx[0] < 90 && capPx[1] < 90, '7a. the frame cap closes the bar on its right (dark pixel after the last fill column)', JSON.stringify(capPx));
  // the label's drawn ink equals the asset's ink (nothing lost, nothing doubled)
  const lab = ui.assets.get('healthbox.hpLabel'); let inkN = 0; for (const v of lab.pixels) if (v === 12) inkN++;
  const lx0 = B.LAYOUT.foeBoxTL[0] + B.LAYOUT.foe.labelX, ly0 = B.LAYOUT.foeBoxTL[1] + B.LAYOUT.foe.labelY, orange = rgb15(lab.palette[12]);
  ok(cnt(f0, lx0, ly0, 16, 8, (r, g, b) => r === orange[0] && g === orange[1] && b === orange[2]) === inkN, '7a. the HP label shows exactly the ROM label ink (' + inkN + ' px)');
}

// ---- 7b. healthbox text never collides with the level; move names never leave their window --------------------------
function fitFindings(uiM) {
  const f = [], t = (n, c) => { if (!c) f.push(n); };
  let overlap = 0, cutLow = 0, cutL100 = 0, n = 0, worst = '';
  for (const side of ['foe', 'player']) for (const lv of [1, 5, 9, 10, 50, 99, 100]) for (const id of legalIds) for (const g of ['M', 'F', null]) {
    const s = uiM.healthboxText(side, { name: pack.species[id].name, level: lv, gender: g }); n++;
    if (s.right > s.lvX - 2) { overlap++; if (!worst) worst = side + ' ' + pack.species[id].name + ' Lv' + lv; }
    if (s.truncated) { if (lv < 100) cutLow++; else cutL100++; }
  }
  t('no name+gender ever reaches into the level text (' + overlap + ' of ' + n + ' overlap ' + worst + ')', overlap === 0);
  { let badFont = 0; for (const id of legalIds) { const w = uiM.measure('small', pack.species[id].name); const s = uiM.healthboxText('foe', { name: pack.species[id].name, level: 50, gender: 'M' }); if (s.nameFont !== (w <= 50 ? 'small' : 'font11')) badFont++; } t('the name font is small up to 50 px and font 11 above (' + badFont + ' species wrong)', badFont === 0); }
  t('no name is cut at Lv1..99 (' + cutLow + ' cut)', cutLow === 0);
  t('at most a few long names are cut at Lv100 (' + cutL100 + ' of ' + (legalIds.length * 3 * 2) + ' cases)', cutL100 <= 120);
  return f;
}

// ---- 7b'. move names, PP numbers and PP colours in the move menu (FA1: replaces S1's two-line / scrolling layouts with the real game's rules) ----------------
// The real game sets every move name in the 'narrow' font (the narrower font 10 when the name is wider than the 64 px window), at the window's left edge,
// never wrapped or scrolled: a too-wide name is clipped by the window. tools/pokemonarena_fidelity_test.mjs proves this against the real game's frames.
const allMoveNames = [...new Set(pack.moves.filter((m) => m && m.name && m.name !== '-').map((m) => m.name))];
function moveNameFindings(uiM) {
  const f = [], t = (n, c) => { if (!c && f.length < 14) f.push(n); };
  const R0 = uiM.R.mv[0], W = uiM.TEXT.white;
  let wrongLayout = 0, mism = 0, clipped = 0;
  const bl = { env: 0, box: { mode: 'moves', cursor: 1, moves: [{ name: '', pp: 1, maxPp: 1, type: 1, typeName: '' }, { name: '-', pp: 1, maxPp: 1, type: 1, typeName: '' }] } };
  for (const nm of allMoveNames) {
    const sl = uiM.moveNameSlot(nm, R0.w), s = uiM.safeText(nm);
    const want = uiM.measure('narrow', s) <= R0.w ? 'narrow' : 'font10';
    if (sl.font !== want || sl.lines.length !== 1 || sl.scroll) { wrongLayout++; t('wrong layout: ' + nm, false); continue; }
    if (uiM.measure(sl.font, s) > R0.w) clipped++;
    const bm = uiM.assets.drawText(sl.font, s);
    let inWin = 0;
    for (let y = 0; y < bm.height; y++) for (let x = 0; x < bm.width; x++) if (bm.pixels[y * bm.width + x] && x < R0.w && y + 1 < R0.h) inWin++;
    bl.box.moves[0].name = nm;
    const fr = uiM.render(bl);
    let n = 0;
    for (let y = R0.y; y < R0.y + R0.h; y++) for (let x = R0.x; x < R0.x + R0.w; x++) { const o = (y * 240 + x) * 4; if (!(fr.rgba[o] === W[0] && fr.rgba[o + 1] === W[1] && fr.rgba[o + 2] === W[2])) n++; }
    if (n !== inWin) { mism++; t('window ink ' + n + " != the font's own ink inside the window " + inWin + ': ' + nm, false); }
  }
  t('a few names are wider than the window even in font 10 and are clipped, not wrapped (' + clipped + ')', clipped >= 10 && clipped < 60);
  return f;
}
{
  ok(allMoveNames.length >= 930, "7b'. the sweep covers every distinct pack move name (" + allMoveNames.length + ')');
  for (const [nm, fontWant] of [['Pound', 'narrow'], ['Stealth Rock', 'narrow'], ['Self-Destruct', 'narrow'], ['Dazzling Gleam', 'font10'], ['Stomping Tantrum', 'font10'], ['Supersonic Skystrike', 'font10'], ['Menacing Moonraze Maelstrom', 'font10']]) { const sl = ui.moveNameSlot(nm, 64); ok(sl.font === fontWant && sl.lines.length === 1, "7b'. moveNameSlot('" + nm + "', 64) uses font '" + fontWant + "' on one line", sl.font + ' ' + sl.lines.length); }
  const r1 = moveNameFindings(ui), r2 = moveNameFindings(ui);
  ok(r1.length === 0, "7b'. all " + allMoveNames.length + " move names are drawn in the real game's font, on one line, clipped by the 64 px window (ink-pixel sweep)", r1.slice(0, 4).join('; '));
  ok(r2.length === 0, "7b'. unmutated twin stays quiet");
  const mFont = await mutantModule([["return w <= maxPx ? { font: 'narrow', shown: s, lines: [s], width: w } : { font: 'font10'", "return w <= maxPx ? { font: 'normal', shown: s, lines: [s], width: w } : { font: 'font10'"]]);
  ok(moveNameFindings(mFont.createBattleUi(rom)).length > 0, "7b'. mutant \"names in the normal font\" is caught");
  const mThr = await mutantModule([["return w <= maxPx ? { font: 'narrow'", "return w <= maxPx - 6 ? { font: 'narrow'"]]);
  ok(moveNameFindings(mThr.createBattleUi(rom)).length > 0, "7b'. mutant \"the narrow-font limit is 58 px, not the window's 64\" is caught");
  const mLane = await mutantModule([["frame.blitRoles(ui.drawText(ms.font, ms.shown), r.x, r.y + 1,", "frame.blitRoles(ui.drawText(ms.font, ms.shown), r.x + 2, r.y + 1,"]]);
  ok(moveNameFindings(mLane.createBattleUi(rom)).length > 0, "7b'. mutant \"the names start 2 px into the window\" is caught");
  // PP colour state: ppState is the ROM's GetCurrentPpToMaxPpState @0x08094dc8 (the full sweep against the ROM's own code is in tools/pokemonarena_fidelity_test.mjs)
  const cases = [[35, 35, 3], [18, 35, 3], [17, 35, 0], [9, 35, 0], [8, 35, 1], [1, 35, 1], [0, 35, 2], [2, 5, 0], [1, 5, 1], [3, 5, 3], [0, 1, 2], [1, 2, 1], [2, 2, 3]];
  ok(cases.every(([c, m, st]) => B.ppState(c, m) === st), "7b'. ppState reproduces the PP colour states read off the real move menu (normal 3, yellow 0, orange 1, red 2)", JSON.stringify(cases.filter(([c, m, st]) => B.ppState(c, m) !== st)));
}

// ---- 7c. level cap: a level-100 mon gains no EXP and the demo does not loop 'grew to' ---------------------------------
function levelCapFindings(Bm) {
  const f = [], t = (n, c) => { if (!c) f.push(n); };
  const u = Bm.createBattleUi(rom);
  const watch = (d, grew, gained) => { let last = null; return () => { if (d.cur && d.cur !== last) { last = d.cur; if (d.cur.t === 'text') { if (/grew to/.test(d.cur.text)) grew.n++; if (/EXP\. Points/.test(d.cur.text)) gained.n++; } } }; };
  { // A: level 100 beats level 100
    const d = new Bm.ScriptedBattle(u, pack, { player: 25, foe: 129, level: 100, textSpeed: 'fast' });
    const grew = { n: 0 }, gained = { n: 0 }, w = watch(d, grew, gained);
    d.settle(); let n = 0, hidden = false, reset = false;
    while (n < 6000) {
      if (d.phase === 'action') { d.press('a'); d.press('a'); }
      d.tick(); n++; w();
      if (!d.foe.visible) hidden = true;
      if (hidden && d.foe.visible) { reset = true; break; }
    }
    t('L100 vs L100: no "grew to" message (got ' + grew.n + ')', grew.n === 0);
    t('L100 vs L100: no "gained EXP" message (got ' + gained.n + ')', gained.n === 0);
    t('L100 vs L100: the battle ends and resets within 6000 frames (reset ' + reset + ', ' + n + ' frames)', reset);
    t('L100: the player stays at level 100', d.player.level === 100);
  }
  { // B: level 99 with a huge award levels up exactly once, to 100, then stops
    const e = new Bm.ScriptedBattle(u, pack, { player: 25, foe: 129, level: 99, textSpeed: 'fast' });
    e.settle(); e.phase = 'steps'; e.expFill(e.player, 1e9);
    const grew = { n: 0 }, w = watch(e, grew, { n: 0 }); let k = 0;
    while (k < 6000 && (e.cur || e.queue.length)) { e.tick(); k++; w(); }
    t('L99 + 1e9 EXP: exactly one "grew to LV. 100" message (got ' + grew.n + ')', grew.n === 1);
    t('L99 + 1e9 EXP: finishes (idle in ' + k + ' frames) at level 100 with an empty bar', k < 6000 && e.player.level === 100 && e.player.expInto === 0);
    e.expFill(e.player, 1e9); const g2 = { n: 0 }, w2 = watch(e, g2, { n: 0 }); let k2 = 0;
    while (k2 < 6000 && (e.cur || e.queue.length)) { e.tick(); k2++; w2(); }
    t('a further award at level 100 is ignored (no message, ' + k2 + ' frames)', g2.n === 0 && k2 <= 3);
  }
  return f;
}
{
  const r1 = levelCapFindings(B), r2 = levelCapFindings(B);
  ok(r1.length === 0, '7c. level cap: level-100 mons gain nothing and never loop the level-up message', r1.slice(0, 4).join('; '));
  ok(r2.length === 0, '7c. unmutated twin stays quiet');
  const guard = 'if (m.level >= MAX_LEVEL) { c.left = 0; this.cur = null; break; }', guard2 = 'if (m.level >= MAX_LEVEL) { m.expInto = 0; c.left = 0; }', guard3 = 'if (this.player.level < MAX_LEVEL) {';
  const mA = await mutantModule([[guard, ''], [guard2, ''], [guard3, 'if (true) {']]);
  const rA = levelCapFindings(mA); ok(rA.length > 0, '7c. mutant "no level cap" (the shipped bug) is caught', rA[0] || 'NOT CAUGHT');
  const mB = await mutantModule([[guard3, 'if (true) {']]);
  const rB = levelCapFindings(mB); ok(rB.length > 0, '7c. mutant "EXP is awarded at level 100" is caught', rB[0] || 'NOT CAUGHT');
  const mC = await mutantModule([[guard2, '']]);
  const rC = levelCapFindings(mC); ok(rC.length > 0, '7c. mutant "the cap does not discard the leftover EXP" is caught', rC[0] || 'NOT CAUGHT');
}

// ---- 7d. faint sink timing and hostile views -----------------------------------------------------------------------
function faintFindings(Bm) {
  const f = [], t = (n, c) => { if (!c) f.push(n); };
  const u = Bm.createBattleUi(rom);
  const d = new Bm.ScriptedBattle(u, pack, { player: 150, foe: 129, level: 50, foeLevel: 5, textSpeed: 'fast' });
  d.settle(); d.press('a'); d.press('a');
  const seq = []; let n = 0, hiddenAt = -1;
  while (n < 4000) {
    d.tick(); n++;
    if (d.foe.drop !== (seq.length ? seq[seq.length - 1] : 0)) seq.push(d.foe.drop);
    if (!d.foe.visible && hiddenAt < 0) hiddenAt = seq.length;
    if (hiddenAt >= 0 && d.foe.visible) break;      // reset
  }
  t('the foe sinks in 16 steps (got ' + hiddenAt + ')', hiddenAt === 16);
  t('every sink step is exactly 4 px (4,8,...,64): ' + seq.slice(0, 17).join(','), seq.slice(0, 16).every((v, i) => v === 4 * (i + 1)));
  return f;
}
function hostileFindings(Bm) {
  const f = [], t = (n, c) => { if (!c) f.push(n); };
  const u = Bm.createBattleUi(rom);
  const views = [];
  for (const env of [-5, 99, 1e9]) views.push(['env ' + env, baseView({ env })]);
  for (const cursor of [-3, 77, 1e9]) { views.push(['action cursor ' + cursor, baseView({ box: { mode: 'action', prompt: ['a', 'b'], cursor } })]); views.push(['moves cursor ' + cursor, baseView({ box: { mode: 'moves', cursor, moves: MOVES } })]); }
  for (const [name, v] of views) { let good = false; try { const r = u.render(v); good = r.width === 240 && r.height === 160 && r.rgba.length === 240 * 160 * 4; } catch (e) { good = false; } t('render survives ' + name, good); }
  return f;
}
{
  const r1 = faintFindings(B), r2 = faintFindings(B);
  ok(r1.length === 0, '7d. faint: the sprite sinks 4 px per frame for 16 frames, then is hidden', r1.slice(0, 3).join('; '));
  ok(r2.length === 0, '7d. unmutated twin stays quiet');
  const m = await mutantModule([['c.mon.drop += 4;', 'c.mon.drop += 5;']]);
  const rm = faintFindings(m); ok(rm.length > 0, '7d. mutant "sink 5 px per frame" is caught', rm[0] || 'NOT CAUGHT');
  const h1 = hostileFindings(B), h2 = hostileFindings(B);
  ok(h1.length === 0, '7d. hostile views (env out of range, cursor out of range) render without throwing', h1.slice(0, 3).join('; '));
  ok(h2.length === 0, '7d. unmutated twin stays quiet');
  const mh = await mutantModule([['const e = env(Math.max(0, Math.min(ENV_COUNT - 1, view.env | 0)));', 'const e = env(view.env | 0);'], ['const c = Math.max(0, Math.min(3, box.cursor | 0)), cr = R.mv[c];', 'const c = box.cursor | 0, cr = R.mv[c];']]);
  const rh = hostileFindings(mh); ok(rh.length > 0, '7d. mutant "no clamps" is caught', rh[0] || 'NOT CAUGHT');
}

/* ================================================================== 8. ROM art for the party / preview / result screens and the weather tags (S1 verifier defect 2) */
//
// WHAT IS PROVEN: the screen background, the slot panels (normal / selected / fainted), the CANCEL button (normal / selected) and the
// RAIN / TRICK ROOM plates are made of pixels decoded from the ROM party-menu bg (PARTY_ART) and the ROM healthbox frame. Proven by
// (a) hash-pinning the decoded tiles / tilemap / palette, (b) reading the expected colours straight from the ROM palette bytes WITHOUT
// going through battle_ui.js and finding them in the frame, (c) editing those ROM palette bytes in a copy and watching exactly those
// pixels change, (d) corrupting the compressed tileset and watching the output change or the decode refuse, (e) a source guard that pins
// the remaining flat-fill call sites so a new drawn-rectangle stand-in cannot slip in unnoticed.
const bank = (r, b, i) => rgb15(r[0x73c650 + b * 32 + i * 2] | (r[0x73c650 + b * 32 + i * 2 + 1] << 8));
const modeColour = (fr, x0, y0, w, h) => { const m = new Map(); for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = (y * 240 + x) * 4, k = fr.rgba[o] + ',' + fr.rgba[o + 1] + ',' + fr.rgba[o + 2]; m.set(k, (m.get(k) || 0) + 1); } let best = '', n = 0; for (const [k, c] of m) if (c > n) { best = k; n = c; } return best; };
const keyOf = (c) => c.join(',');
function artFindings(uiM, romBytes) {
  const f = [], t = (n, c) => { if (!c && f.length < 14) f.push(n); };
  const G = uiM.GEOM.party;
  const pv = partyView(2, false), fr = uiM.render(pv), rows = uiM.rowRects(G, 6);
  // rows: 0 fainted (grey), 1..5 normal; make the selected row 2
  const want = { bg: keyOf(bank(romBytes, 1, 1)), normal: keyOf(bank(romBytes, 1, 2)), grey: keyOf(bank(romBytes, 0, 2)), sel: keyOf(bank(romBytes, 1, 4)) };
  t('screen background is ROM bank1 index1', modeColour(fr, 0, 150, 20, 10) === want.bg);
  t('fainted row panel is ROM bank0 index2', modeColour(fr, rows[0].x + 14, rows[0].y + 2, rows[0].w - 18, rows[0].h - 4) === want.grey);
  t('normal row panel is ROM bank1 index2', modeColour(fr, rows[3].x + 14, rows[3].y + 2, rows[3].w - 18, rows[3].h - 4) === want.normal);
  t('selected row panel is ROM bank1 index4', modeColour(fr, rows[2].x + 14, rows[2].y + 2, rows[2].w - 18, rows[2].h - 4) === want.sel);
  // cancel button: outline colour counts
  const cn = B.PARTY_ART.cancel, cbx = G.cancel.x + ((G.cancel.w - cn.w) >> 1);
  const count = (frame, x0, y0, w, h, col) => { let n = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = (y * 240 + x) * 4; if (frame.rgba[o] === col[0] && frame.rgba[o + 1] === col[1] && frame.rgba[o + 2] === col[2]) n++; } return n; };
  const frSel = uiM.render(partyView(2, true));
  t('unselected CANCEL is outlined in ROM bank1 index13', count(fr, cbx, cn.y, cn.w, cn.h, bank(romBytes, 1, 13)) > 100 && count(frSel, cbx, cn.y, cn.w, cn.h, bank(romBytes, 1, 13)) === 0);
  t('selected CANCEL is outlined in ROM bank2 index13', count(frSel, cbx, cn.y, cn.w, cn.h, bank(romBytes, 2, 13)) > 100 && count(fr, cbx, cn.y, cn.w, cn.h, bank(romBytes, 2, 13)) === 0);
  // preview and result screens use the same ROM bg
  const fp = uiM.render(previewView(0, [])), fres = uiM.render(resultView(0));
  t('preview background is ROM bank1 index1', modeColour(fp, 117, 60, 6, 40) === want.bg);
  t('result background is ROM bank1 index1', modeColour(fres, 230, 60, 10, 80) === want.bg);
  const rr = uiM.resultRects(resultView(0).result).options;
  t('result option panel (selected) is ROM bank1 index4', modeColour(fres, rr[0].x + 4, rr[0].y + 13, rr[0].w - 8, 2) === want.sel);
  t('result option panel (normal) is ROM bank1 index2', modeColour(fres, rr[1].x + 4, rr[1].y + 13, rr[1].w - 8, 2) === want.normal);
  // tags: plate = the ROM healthbox frame pixels
  const tg = baseView({ box: { mode: 'message', text: ['', ''] } }); tg.tags = ['TRICK ROOM', 'SUN'];
  const ft = uiM.render(tg), tr = uiM.tagRects(tg.tags), art = uiM.healthboxArt('foe');
  let same = 0, tot = 0;
  for (const r of tr) for (const [px, py, ax, ay] of [[r.x + 1, r.y + 2, 1, 2], [r.x + 5, r.y, 30, 0], [r.x + 6, r.y + 1, 30, 1], [r.x + 6, r.y + r.h - 2, 30, 29], [r.x + 6, r.y + r.h - 1, 30, 30], [r.x + r.w - 2, r.y + 2, 1, 2]]) {
    tot++; const o = (py * 240 + px) * 4, a = (ay * art.width + ax) * 4; if (ft.rgba[o] === art.rgba[a] && ft.rgba[o + 1] === art.rgba[a + 1] && ft.rgba[o + 2] === art.rgba[a + 2]) same++;
  }
  t('tag plate pixels equal the ROM healthbox frame pixels (' + same + '/' + tot + ')', same === tot);
  t('tag plates stay on the screen and do not overlap', tr.every((r, i) => r.x >= 0 && r.x + r.w <= 240 && (i === 0 || tr[i - 1].x >= r.x + r.w)));
  return f;
}
{
  const f1 = artFindings(ui, rom), f2 = artFindings(ui, rom);
  ok(f1.length === 0, '8a. background, row panels (normal / selected / fainted), CANCEL button (normal / selected), result options and tag plates all carry ROM-palette colours read straight from the ROM bytes', f1.slice(0, 4).join('; '));
  ok(f2.length === 0, '8a. unmutated twin stays quiet');
  // (c) edit the ROM palette bytes in a copy: exactly those pixels change
  const edits = [['bank1 idx2 -> red', 0x73c650 + 32 + 4, 0x1f, 0x00, 'normal row'], ['bank0 idx2 -> red', 0x73c650 + 4, 0x1f, 0x00, 'fainted row'], ['bank1 idx1 -> red', 0x73c650 + 32 + 2, 0x1f, 0x00, 'background'], ['bank2 idx13 -> green', 0x73c650 + 64 + 26, 0xe0, 0x03, 'selected cancel']];
  for (const [nm, off, lo, hi, what] of edits) {
    const r = copyRom(); r[off] = lo; r[off + 1] = hi;
    const u2 = B.createBattleUi(r), fr0 = ui.render(partyView(2, nm.startsWith('bank2'))), fr1 = u2.render(partyView(2, nm.startsWith('bank2')));
    const f = artFindings(u2, rom);        // expectations read from the ORIGINAL rom: the edited copy must now fail them
    ok(hashFrame(fr0) !== hashFrame(fr1) && f.length > 0, '8b. editing the ROM palette (' + nm + ') changes the ' + what + ' and the provenance check notices', f[0] || 'NO CHANGE');
    const g = artFindings(u2, r); ok(g.length === 0, '8b. ...and against the edited ROM the same check passes (the colours really come from those bytes) [' + nm + ']', g[0] || '');
  }
  // tag plate colours follow the healthbox palette (ROM 0x72140c)
  { const r = copyRom(); for (let i = 1; i < 16; i++) { r[0x72140c + i * 2] = 0xe0; r[0x72140c + i * 2 + 1] = 0x03; }
    const tg = baseView({ box: { mode: 'message', text: ['', ''] } }); tg.tags = ['RAIN'];
    const a = ui.render(tg), b = B.createBattleUi(r).render(tg), tr = ui.tagRects(tg.tags)[0], o = ((tr.y + 8) * 240 + tr.x + 2) * 4;
    ok(a.rgba[o] !== b.rgba[o] || a.rgba[o + 1] !== b.rgba[o + 1], '8b. recolouring the ROM healthbox palette recolours the weather tag plate'); }
  // (d) corrupt the compressed tileset: refuse or change
  { let changed = 0; const base = hashFrame(ui.render(partyView(2, false)));
    for (const dOff of [8, 20, 40, 64, 100, 300]) { const r = copyRom(); r[0x73c850 + dOff] ^= 0xa5; let h; try { h = hashFrame(B.createBattleUi(r).render(partyView(2, false))); } catch (_e) { h = 'threw'; } if (h !== base) changed++; }
    ok(changed >= 5, '8c. corrupting the compressed ROM party-menu tileset changes the output or makes the decode refuse (' + changed + ' of 6 bytes)'); }
  { const r = copyRom(); const h = hashFrame(B.createBattleUi(r).render(partyView(2, false))); ok(h === hashFrame(ui.render(partyView(2, false))), '8c. an unmutated ROM copy renders the party screen byte-identically (twin)'); }
  // (e) the remaining flat fills are pinned
  const src = fs.readFileSync(path.join(jsDir, 'battle_ui.js'), 'utf8');
  const rectLines = src.split('\n').filter((l) => /\.rect\(/.test(l) && !/^\s*rect\(/.test(l) && !/^\s*\/\//.test(l)).map((l) => l.trim());
  const KNOWN = ['const fillWin = (frame, r) => frame.rect(r.x, r.y, r.w, r.h, TEXT.white);', 'frame.rect(R.menu.x - 8, R.menu.y, 8, R.menu.h, TEXT.white);', 'for (const r of R.mv) frame.rect(r.x - 8, r.y, 8, r.h, TEXT.white);', 'frame.rect(x, y, w, h, o.fill || TEXT.white);'];
  const guardOf = (text) => { const ls = text.split('\n').filter((l) => /\.rect\(/.test(l) && !/^\s*rect\(/.test(l) && !/^\s*\/\//.test(l)).map((l) => l.trim()); return ls.length === KNOWN.length && KNOWN.every((k) => ls.includes(k)); };
  ok(rectLines.length === KNOWN.length && guardOf(src), '8d. the only drawn-rectangle fills left in battle_ui.js are the four window-interior / cursor-lane fills the ROM itself performs at run time (' + rectLines.length + ' call sites)', rectLines.join(' | '));
  ok(!guardOf(src + '\n  frame.rect(x, y, w, 11, COL.dark);') && !guardOf(src.replace('frame.rect(x, y, w, h, o.fill || TEXT.white);', '')), '8d. the guard notices an added rect call and a removed one (negative control)');
}

// ---- 8e. panel geometry: a 9-slice of the ROM slot, flat inside, stable edges ---------------------------------------------------------
{
  const f = [], t = (n, c) => { if (!c && f.length < 8) f.push(n); };
  for (const variant of ['normal', 'sel', 'grey']) for (const sq of [false, true]) for (const [w, h] of [[16, 16], [34, 34], [70, 16], [112, 22], [136, 23], [200, 60]]) {
    const a = ui.panelRGBA(variant, w, h, sq), px = (x, y) => a.subarray((y * w + x) * 4, (y * w + x) * 4 + 4);
    t(variant + ' ' + w + 'x' + h + ': buffer size', a.length === w * h * 4);
    t(variant + ' ' + w + 'x' + h + ': the top-left corner is ' + (sq ? 'square (opaque)' : 'chamfered (transparent)'), (px(0, 0)[3] === 255) === sq);
    t(variant + ' ' + w + 'x' + h + ': the interior is opaque', px(w >> 1, h >> 1)[3] === 255 && px(w - 5, h - 5)[3] === 255);
    const mid = keyOf(Array.from(px(w >> 1, h >> 1)).slice(0, 3));
    let flat = true; for (let y = 12; y < h - 4; y += 3) for (let x = 12; x < w - 4; x += 5) if (keyOf(Array.from(px(x, y)).slice(0, 3)) !== mid) flat = false;
    t(variant + ' ' + w + 'x' + h + ': the interior is one flat ROM colour', flat || (w < 20 || h < 20));
  }
  { const a = ui.panelRGBA('normal', 60, 30, false), b = ui.panelRGBA('normal', 140, 44, false); let same = true; for (let y = 0; y < 26; y++) for (let k = 0; k < 3; k++) for (let c = 0; c < 4; c++) { if (a[(y * 60 + 60 - 3 + k) * 4 + c] !== b[(y * 140 + 140 - 3 + k) * 4 + c]) same = false; } t('the 3 right-edge columns are the same ROM pixels at any width', same); }
  ok(f.length === 0, '8e. slot panels: sizes, chamfer vs square corners, flat interiors, stable edges (variants normal / sel / grey)', f.slice(0, 3).join('; '));
  ok(ui.panelRGBA('normal', 40, 20, false) !== ui.panelRGBA('sel', 40, 20, false) && keyOf(Array.from(ui.panelRGBA('normal', 40, 20).subarray(((10) * 40 + 20) * 4, ((10) * 40 + 20) * 4 + 3))) !== keyOf(Array.from(ui.panelRGBA('sel', 40, 20).subarray(((10) * 40 + 20) * 4, ((10) * 40 + 20) * 4 + 3))), '8e. the variants differ in colour');
}

// ---- 8f. icons never overlap the neighbouring row; result labels never touch their panels -------------------------------------------------
function iconOverlapFindings(uiM) {
  const f = [], t = (n, c) => { if (!c && f.length < 6) f.push(n); };
  const bg = bank(rom, 1, 1), Gp = uiM.GEOM.preview;
  let bad = 0, checked = 0, first = '';
  for (let s0 = 0; s0 < legalIds.length; s0 += 6) {
    for (const tick of [0, 8]) {
      const ids = legalIds.slice(s0, s0 + 6); while (ids.length < 6) ids.push(ids[0]);
      const mk = (id) => ({ species: id, name: pack.species[id].name, level: 50, gender: null, hp: 1, maxHp: 1, status: null, fainted: false, active: false, shiny: false });
      const fr = uiM.render({ screen: 'preview', preview: { mine: ids.map(mk), foe: ids.slice().reverse().map(mk), picks: [], cursor: 3, tick, title: '', foeTitle: '', prompt: [] } });
      for (const [G, n] of [[Gp.mine, 6], [Gp.foe, 6]]) {
        const rows = uiM.rowRects(G, n);
        for (let i = 0; i < n; i++) {
          const r = rows[i]; checked++;
          for (let y = r.y + r.h; y < r.y + G.pitch; y++) for (let x = r.x + 2; x < r.x + 34; x++) { const o = (y * 240 + x) * 4; if (fr.rgba[o] !== bg[0] || fr.rgba[o + 1] !== bg[1] || fr.rgba[o + 2] !== bg[2]) { bad++; if (!first) first = pack.species[ids[G === Gp.mine ? i : 5 - i]].name; y = 999; break; } }
        }
      }
    }
  }
  t('icon pixels land in the gap between preview rows in ' + bad + ' of ' + checked + ' rows (first: ' + first + ')', bad === 0);
  const rg = uiM.render(resultView(0)), Gr = uiM.GEOM.result;
  for (const [g, label] of [[Gr.mine, 'YOU'], [Gr.foe, 'CPU NORMAL']]) {
    const w = uiM.measure('small', label); let n = 0;
    for (const y of [g.y - 1, g.y - 2]) for (let x = g.x; x < g.x + w + 2; x++) { const o = (y * 240 + x) * 4; if (rg.rgba[o] !== bg[0] || rg.rgba[o + 1] !== bg[1] || rg.rgba[o + 2] !== bg[2]) n++; }
    t('the result label ' + label + ' touches its panel (' + n + ' px in the 2 rows above it)', n === 0);
  }
  return f;
}
{
  const r1 = iconOverlapFindings(ui), r2 = iconOverlapFindings(ui);
  ok(r1.length === 0, '8f. no icon of any of the ' + legalIds.length + ' legal species spills into the gap below its team-preview row; result labels stay clear of their panels', r1.slice(0, 3).join('; '));
  ok(r2.length === 0, '8f. unmutated twin stays quiet');
  const m1 = await mutantModule([['clipIcon: true', 'clipIcon: false']]);
  const q1 = iconOverlapFindings(m1.createBattleUi(rom)); ok(q1.length > 0, '8f. mutant "icons are neither centred nor clipped" (the shipped bug) is caught', q1[0] || 'NOT CAUGHT');
  const m2 = await mutantModule([['g.y - 14, TEXT.white, TEXT.dark', 'g.y - 11, TEXT.white, TEXT.dark']]);
  const q2 = iconOverlapFindings(m2.createBattleUi(rom)); ok(q2.length > 0, '8f. mutant "result label back at y-11" (the shipped bug) is caught', q2[0] || 'NOT CAUGHT');
}

// ---- 8g. the narrow fonts' touching glyphs are the ROM's own spacing (S1 verifier minor 5) -------------------------------------------------
// 'Stealth Rock' / 'Light Screen' look cramped in the ROM narrow font. Before changing any spacing: the advance of every glyph here must be
// exactly the ROM's width table entry plus the FontInfo letterSpacing byte (ROM 0x111ab64 + id * 12 + 6), read below from the ROM bytes
// WITHOUT going through uiassets.js. If it is, the cramped look IS the ROM's (its glyph cells carry no gap column: see the dump in the report).
function advanceFindings(uiM) {
  const f = [], t = (n, c) => { if (!c && f.length < 6) f.push(n); };
  const defs = { normal: [1, 0x60df24], narrow: [7, 0x61e324], font10: [10, 0x605d24], font11: [11, 0x5fdb24], small: [0, 0x626524], smallNarrow: [8, 0x62e724] };
  for (const [name, [id, glyphs]] of Object.entries(defs)) {
    const ls = rom[0x111ab64 + id * 12 + 6] > 127 ? rom[0x111ab64 + id * 12 + 6] - 256 : rom[0x111ab64 + id * 12 + 6];
    for (const str of ['Stealth Rock', 'Light Screen', 'Dazzling Gleam']) {
      const codes = Array.from(U.encodeText(str)); let w = 0; for (const c of codes) w += rom[glyphs - 0x200 + c] + ls;
      t(name + ' "' + str + '": measured ' + uiM.measure(name, str) + ' != ROM width table + letterSpacing ' + w, uiM.measure(name, str) === w);
    }
  }
  return f;
}
{
  const a1 = advanceFindings(ui), a2 = advanceFindings(ui);
  ok(a1.length === 0, "8g. every glyph advance is the ROM width table plus the ROM FontInfo letterSpacing (the narrow fonts' touching glyphs are the ROM's own)", a1.join('; '));
  ok(a2.length === 0, '8g. unmutated twin stays quiet');
  const mA = await mutantModule([['const widthOf = (font, s) => ui.measureText(font, safeText(s));', 'const widthOf = (font, s) => ui.measureText(font, safeText(s)) + safeText(s).length;']]);
  const a3 = advanceFindings(mA.createBattleUi(rom)); ok(a3.length > 0, '8g. mutant "one extra pixel between glyphs" is caught', a3[0] || 'NOT CAUGHT');
}
// ---- 9. W1 fix D4: a team-preview row shows the WHOLE species name (it used to cut 'Victreebel' to 'Victreeb', 'Raging Bolt' to 'Raging B') ----------------------------
function previewNameFindings(uiM) {
  // the longest legal names: a name is drawn whole when taking one letter off it CHANGES the frame (if both clipped to the same prefix, the frames would be identical)
  const longest = legalIds.map((id) => pack.species[id].name).filter((n) => n.length >= 9).sort((x, y) => uiM.measure('small', y) - uiM.measure('small', x)).slice(0, 12).concat(['Victreebel', 'Raging Bolt', 'Iron Hands', 'Dudunsparce', 'Mandibuzz', 'Pachirisu', 'Heracross']);
  const bad = [];
  const id0 = legalIds[0];
  const frame = (name) => uiM.render({ screen: 'preview', preview: { mine: [{ species: id0, name, level: 50, gender: null, hp: 1, maxHp: 1, status: null, fainted: false, active: false, shiny: false }], foe: [], picks: [], cursor: 0, tick: 0, title: '', foeTitle: '', prompt: [] } }).rgba;
  for (const n of [...new Set(longest)]) {
    const a = frame(n), b = frame(n.slice(0, -1));
    let same = true; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
    if (same) bad.push(n);
  }
  return bad;
}
{
  const p1 = previewNameFindings(ui);
  ok(p1.length === 0, '9. every long species name is drawn whole on the team preview (taking a letter off any of them changes the picture)', p1.join(', '));
  ok(previewNameFindings(ui).length === 0, '9. unmutated twin stays quiet');
  const mD = await mutantModule([['const nameMax = o.showHp === false ? r.w - 36 - 12 : r.w - 36 - lw - 18;', 'const nameMax = r.w - 36 - lw - 18;']]);
  const p3 = previewNameFindings(mD.createBattleUi(rom)); ok(p3.length > 0, '9. mutant "the preview name keeps the width of the level reserved" is caught (' + p3.length + ' names clipped)', p3[0] || 'NOT CAUGHT');
}
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }

console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log(failures.join('\n')); process.exit(1); }
