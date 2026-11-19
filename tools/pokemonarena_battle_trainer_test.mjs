#!/usr/bin/env node
// POKEMONARENA BATTLE TRAINER TEST -- the battle page shows the TRAINER (INAPP.md "TRAINER", decision 3; "BATTLE: as built" there): the player's NAME and BACK figure from the profile that fights, and
// an online opponent's FRONT figure. No browser; the real ROM.
//
//   A  THE PAGE'S CHOICES   battle_boot.js trainerShown(profile, backs) (the name fallback, the back mapping) and foeTrainerFor(rom, fig) (the foe-figure choice); trainer_figures.js backChoices(rom).
//   B  THE ROM DRAWS IT     the ROM's own trainer intro (move_anim.js / battle_sys.js, the real engine) with the save block's gender byte at every index backChoices gives: the player's back picture is
//                           speciesgfx.js trainerBack(rom, i) PIXEL-EXACT (every opaque pixel, its own palette) where the two genders stand, no other back picture is, and nothing else of the
//                           picture differs from index 0; 'M' / 'F' are 0 / 1; an index outside the ROM's table is written as 0. (The measurement behind backChoices: INAPP.md.)
//   C  THE NAME IN THE BATTLE  a battle played to its result with a 10-letter name of the widest ROM-font letters: the sentence that names the player ("<mon> went back to <name>!") wraps inside the
//                           message box, the result screen's label and every recap cell that holds it are set without a cut and inside the window; no name = 'You' as before.
//   D  MUTANTS              one-snippet defects of battle_boot.js / trainer_figures.js / battle_sys.js / scene.js (in a temp copy of the module tree), each of which must trip a NAMED check.
//
//   node tools/pokemonarena_battle_trainer_test.mjs          ARENA_SKIP_MUTANTS=1 skips D; ARENA_VERBOSE=1 lists every check
// Pure ASCII. Writes only a temp copy of pokemonarena/js (for the mutants). Nothing decoded from the ROM is written anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
if (!fs.existsSync(ROM_PATH)) { console.error('ROM not found: ' + ROM_PATH); process.exit(2); }
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'));
const J = (x) => JSON.stringify(x);
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('  ok   ' + name); } else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 300) : '')); } }

async function loadStack(dir, bust = '') {
  const u = (f) => import(pathToFileURL(path.join(dir, f)).href + bust);
  const [BO, TF, SG, MA, BS, T, MC, AI, SC, B, BT, RC, PD, TX] = await Promise.all(['battle_boot.js', 'trainer_figures.js', 'speciesgfx.js', 'move_anim.js', 'battle_sys.js', 'tables.js', 'matchctl.js', 'ai.js', 'scene.js', 'battle_ui.js', 'battle_text.js', 'recap_model.js', 'page_draw.js', 'textfx.js'].map(u));
  return { BO, TF, SG, MA, BS, T, MC, AI, SC, B, BT, RC, PD, TX, dir };
}

/* =================================================================================================== the checks (any module tree) -> [failed check names] */
async function suite(M, o = {}) {
  const f = []; f.total = 0;
  const t = (name, cond, detail) => { f.total++; if (cond !== true) f.push(name + (detail ? ' [' + String(detail).slice(0, 200) + ']' : '')); else if (process.env.ARENA_VERBOSE && !o.quiet) console.log('  ok   ' + name); };
  const { BO, TF, SG } = M;
  const ALL = [0, 1, 2, 3, 4, 5, 6, 7];

  /* ---- A. the page's choices ---- */
  const card = (o2) => ({ made: true, look: null, front: null, back: null, partner: null, ...o2 });
  const S = (p, backs = ALL) => BO.trainerShown(p, backs);
  t('A1 name-fallback: no profile is "You" with the ROM\'s default back', J(S(null)) === J({ name: 'You', back: null }), J(S(null)));
  t('A1 name-fallback: an empty, a blank or a missing trainer name is "You"', ['', '   ', undefined, 7, null].every((n) => S({ trainerName: n, card: card({ back: 2 }) }).name === 'You'), J(['', '   '].map((n) => S({ trainerName: n }).name)));
  t('A1 name: a profile\'s trainer name is the player\'s name (trimmed)', S({ trainerName: ' Casey ', card: card() }).name === 'Casey' && S({ trainerName: 'ZZZZZZZZZZ' }).name === 'ZZZZZZZZZZ', S({ trainerName: ' Casey ' }).name);
  t('A1 name: a name longer than ' + BO.TRAINER_NAME_MAX + ' is cut to it', BO.TRAINER_NAME_MAX === 10 && S({ trainerName: 'ABCDEFGHIJKLMNOP' }).name === 'ABCDEFGHIJ', S({ trainerName: 'ABCDEFGHIJKLMNOP' }).name);
  t('A2 back-mapping: the card\'s back figure is handed over when the ROM draws it (0, 1, 5, 7)', [0, 1, 5, 7].every((b) => S({ trainerName: 'A', card: card({ back: b }) }).back === b), J([0, 1, 5, 7].map((b) => S({ trainerName: 'A', card: card({ back: b }) }).back)));
  t('A2 back-mapping: no figure chosen (null), a profile from before schema 6 (no card) and a broken card give null (the ROM\'s default)', S({ trainerName: 'A', card: card({ back: null }) }).back === null && S({ trainerName: 'A' }).back === null && S({ trainerName: 'A', card: 'x' }).back === null && S({ trainerName: 'A', card: card({ back: 2.5 }) }).back === null);
  t('A2 back-mapping: a figure the ROM cannot draw is not handed over (8 of [0..7], 3 of [0, 1], any of no list)', S({ card: card({ back: 8 }) }).back === null && S({ card: card({ back: 3 }) }, [0, 1]).back === null && S({ card: card({ back: 1 }) }, null).back === null && S({ card: card({ back: 1 }) }, [0, 1]).back === 1);
  const fronts = TF.frontChoices(rom);
  const sample = fronts.length ? [fronts[0], fronts[Math.floor(fronts.length / 2)], fronts[fronts.length - 1]] : [];
  let unused = -1; for (let p = 0; p < 256 && unused < 0; p++) if (!fronts.some((c) => c.pic === p)) unused = p;
  t('A3 foe-figure: an opponent\'s figure maps to the ROM trainer that shows it (trainerForFront), for three pictures of ' + fronts.length, sample.length === 3 && sample.every((c) => BO.foeTrainerFor(rom, c.pic) === c.trainerId && c.trainerId > 0), J(sample.map((c) => [c.pic, c.trainerId, BO.foeTrainerFor(rom, c.pic)])));
  t('A3 foe-figure: no figure (null, absent), a non-integer, or a picture no ROM trainer uses gives 0 (the page keeps its own choice)', [null, undefined, '5', 2.5, -1].every((x) => BO.foeTrainerFor(rom, x) === 0) && unused >= 0 && BO.foeTrainerFor(rom, unused) === 0, 'unused ' + unused);
  t('A4 back-choices: on this ROM every index of its back table (0..' + (SG.TRAINER_BACK_COUNT - 1) + ') is a choice', J(TF.backChoices(rom)) === J(Array.from({ length: SG.TRAINER_BACK_COUNT }, (_v, i) => i)), J(TF.backChoices(rom)));
  t('A4 back-choices: a ROM this was not measured on keeps the two genders', J(TF.backChoices(new Uint8Array(64))) === J([0, 1]) && J(TF.backChoices(null)) === J([0, 1]), J(TF.backChoices(new Uint8Array(64))));

  /* ---- B. the ROM draws it ---- */
  {
    const an = await M.MA.createMoveAnimator({ rom });
    const AT = 48, STAND = 100;          // where (x, y) and when (frame) the player's trainer stands in the opening (measured: frames 44..188 at 48,48 for every index)
    const backs = Array.from({ length: SG.TRAINER_BACK_COUNT }, (_v, i) => { const b = SG.trainerBack(rom, i); return b.frames.map((fr) => { const px = []; for (let y = 0; y < fr.height; y++) for (let x = 0; x < fr.width; x++) { const v = fr.pixels[y * fr.width + x]; if (v) { const c = b.palette[v]; px.push([x, y, c & 31, (c >> 5) & 31, (c >> 10) & 31]); } } return px; }); });
    const drawn = (img, px) => px.every(([x, y, r, g, b]) => { const p = ((AT + y) * 240 + AT + x) * 4; return (img[p] >> 3) === r && (img[p + 1] >> 3) === g && (img[p + 2] >> 3) === b; });
    const fnvMasked = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { const p = i >> 2, x = p % 240, y = (p / 240) | 0; const v = x < 120 && y >= 40 && y < 112 ? 0 : a[i]; h = Math.imul(h ^ v, 16777619) >>> 0; } return h; };
    const fnv = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) >>> 0; return h; };
    const shot = (gender) => { try { return shot0(gender); } catch (e) { return { obj: new Uint8Array(240 * 160 * 4), full: -1, outside: -1, frame: -1, err: String(e && e.message ? e.message : e).slice(0, 80) }; } };
    const shot0 = (gender) => {
      const run = an.start('system', 1, { foe: { species: 19, level: 5 }, player: { species: 4, level: 5 }, seed: 5, maxFrames: 900, ...(gender !== undefined ? { gender } : {}) });
      for (let i = 0; i < STAND && !run.done; i++) run.step();
      const obj = Uint8Array.from(run.draw(null, { layers: 0x10 })), all = Uint8Array.from(run.draw(null));
      const r = { obj, full: fnv(all), outside: fnvMasked(all), frame: run.frame };
      if (typeof run.dispose === 'function') run.dispose();
      return r;
    };
    const idx = TF.backChoices(rom);
    const shots = idx.map((i) => shot(i));
    const seenAs = shots.map((s) => backs.map((fr, j) => fr.some((px) => drawn(s.obj, px)) ? j : -1).filter((j) => j >= 0));
    t('B1 rom-back: every back choice (' + idx.join(',') + ') draws its own trainerBack picture pixel-exact, in its own palette, where the genders stand, and no other one', shots.every((s) => s.frame === STAND) && seenAs.every((js, k) => js.length === 1 && js[0] === idx[k]), J(seenAs));
    t('B2 rom-back: nothing else of the picture changes with the back figure (outside the trainer\'s area every index is index 0)', shots.every((s) => s.outside === shots[0].outside) && new Set(shots.map((s) => s.full)).size === idx.length, J(shots.map((s) => [s.outside.toString(16), s.full.toString(16)])));
    const sM = shot('M'), sF = shot('F'), s8 = shot(SG.TRAINER_BACK_COUNT), sNeg = shot(-1), sNone = shot(undefined);
    t('B3 rom-back: "M" and "F" are indexes 0 and 1; no gender is 0', sM.full === shots[0].full && sF.full === shots[1].full && sNone.full === shots[0].full);
    t('B3 rom-back: an index outside the ROM\'s back table (' + SG.TRAINER_BACK_COUNT + ', -1) is written as 0, never read past the table', s8.full === shots[0].full && sNeg.full === shots[0].full, J([s8.full, sNeg.full, shots[0].full]));
  }

  /* ---- C. the name in the battle ---- */
  {
    const { T, MC, AI, SC, B, BT, RC, PD, TX } = M;
    const pack = T.loadPack(rom, { verify: 'header', dexText: false });
    const ui = B.createBattleUi(rom), text = BT.loadBattleText(rom, manifest), pd = PD.createPageDrawer(ui);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const widest = (font, set) => [...set].sort((a, b) => ui.measure(font, b) - ui.measure(font, a))[0];
    const NAME = widest('normal', letters).repeat(10), LABEL = widest('small', letters.toUpperCase()).repeat(10);
    // C1: the one battle sentence that names the player (the ROM's "{f} went back to {35}!", {35} = the owner: the player's own name for the player's Pokemon)
    const went = text.compose('wentback', { subj: 'Feraligatr', ownerName: NAME });
    const tw = TX.createTypewriter({ text: ui.safeText(went), measure: (s) => ui.measure('normal', s), maxWidth: ui.R.msg.w - 4 });
    const lines = tw.pages.flat();
    const widths = lines.map((l) => ui.measure('normal', l));
    t('C1 name-sentence: "<mon> went back to <name>!" names the player, and with 10 of the widest letters it wraps inside the message box (' + (ui.R.msg.w - 4) + ' px a line)', went === 'Feraligatr went back to ' + NAME + '!' && lines.length >= 1 && widths.every((w) => w <= ui.R.msg.w - 4), J([went, tw.pages, widths]));
    // C2 / C3: a real battle to its result with that name
    const play = (playerName) => {
      const A = MC.randomTeam(pack, 61001, 6), Bt = MC.randomTeam(pack, 61002, 6);
      const ctl = MC.createMatchController({ pack, teams: [A.recs, Bt.recs], seed: 61, pick: 3, names: ['You', 'CPU Normal'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 66 }] });
      const scene = SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, Bt.meta], trainer: 'CPU Normal', ...(playerName !== undefined ? { playerName } : {}), resultOptions: ['REMATCH', 'NEW BATTLE', 'BACK TO HUB'] });
      ctl.start(); scene.begin();
      const ai = AI.createAi({ pack, level: 'normal', seed: 7 });
      let n = 0;
      while (n++ < 700000 && scene.mode !== 'result') {
        scene.tick();
        if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
        const m = scene.mode;
        if (m === 'preview') { const p = scene.S.preview; if (p.picks.length < p.pick) { scene.press('a'); if (scene.mode === 'preview') scene.press('down'); } }
        else if (m === 'confirm') scene.press('a');
        else if (m === 'action' || m === 'moves' || m === 'party') { const req = ctl.pending(0); if (req) { const c = ai.choose(req, ctl.view(0), { previewInfo: { foe: ctl.previewInfo[1] } }); scene.S.mode = 'steps'; ctl.submit(0, c); scene.S.party = null; scene.S.mode = 'steps'; } }
      }
      return scene;
    };
    const sc = play(NAME);
    const res = sc.mode === 'result' ? sc.view().result : null;
    t('C2 name-result: the result screen labels the player\'s row with the name (upper case), set inside the screen in the small ROM font', !!res && res.mineLabel === NAME.toUpperCase() && 8 + ui.measure('small', ui.safeText(res.mineLabel)) <= 240, J(res && res.mineLabel));
    let pages = [];
    if (res) {
      for (let i = 0; i < SC.RESULT_GUARD_FRAMES + 5; i++) sc.tick();
      sc.S.result.cursor = -1; sc.press('a');
      if (sc.mode === 'recap') for (let i = 0; i < 7; i++) { sc.S.recap.page = i; const v = sc.view(); if (v.screen !== 'recap' || !v.recap.page || v.recap.index !== i) break; pages.push(v.recap.page); }
    }
    const withName = RC.allCells(pages).filter((c) => c.t === NAME.toUpperCase());
    const bad = withName.filter((c) => { const r = pd.fit(c); const x0 = c.a === 'r' ? c.x + c.w - r.w : c.a === 'c' ? c.x + Math.floor((c.w - r.w) / 2) : c.x; return r.cut || x0 < 0 || x0 + r.w > RC.PAGE_W; });
    t('C3 name-recap: the recap the scene builds labels the player with the name on its team, moves and compare pages (' + withName.length + ' cells), every one set without a cut inside the window', pages.length === 7 && withName.length >= 3 && new Set(withName.map((c) => c.page)).size >= 3 && bad.length === 0, J({ pages: pages.length, cells: withName.map((c) => c.page + ':' + c.w), bad: bad.map((c) => c.page) }));
    const L2 = RC.buildRecapPages(sc.summary(), { mineLabel: LABEL, foeLabel: LABEL });
    const cut2 = RC.allCells(L2).filter((c) => c.t === LABEL && pd.fit(c).cut);
    t('C3 name-recap: 10 of the widest upper-case letters on BOTH sides fit every recap cell without a cut', RC.allCells(L2).filter((c) => c.t === LABEL).length >= 6 && cut2.length === 0, J(cut2.map((c) => c.page + ':' + c.w)));
    const plain = play(undefined), pres = plain.mode === 'result' ? plain.view().result : null;
    t('C4 name-fallback: a scene given no name still says YOU (the battle before profiles had names)', !!pres && pres.mineLabel === 'YOU', J(pres && pres.mineLabel));
  }
  return f;
}

/* =================================================================================================== run */
const t0 = Date.now();
const real = await loadStack(JS);
const realFails = await suite(real);
for (const x of realFails) ok(false, 'real tree: ' + x);
pass += realFails.total - realFails.length;          // (each named check that held on the real tree counts as one pass)
ok(realFails.length === 0 && realFails.total === 20, '1. every check passes on the real tree (' + (realFails.total - realFails.length) + ' of ' + realFails.total + ')');

/* ---- D. mutants ---- */
const MUTANTS = [
  ['battle_boot.js', 'name-fallback: an empty name is shown as empty (no "You")', "return { name: n || 'You',", 'return { name: n,', 'A1 name-fallback'],
  ['battle_boot.js', 'name: a long name is not cut', '.trim().slice(0, TRAINER_NAME_MAX).trim()', '.trim()', 'A1 name: a name longer'],
  ['battle_boot.js', 'back-mapping: any back figure is handed over, drawable or not', '&& Array.isArray(backs) && backs.includes(b) ? b : null', '? b : null', 'A2 back-mapping: a figure the ROM cannot draw'],
  ['battle_boot.js', 'back-mapping: the card is never read (always the ROM default)', 'const b = cardOf(profile).back;', 'const b = null;', 'A2 back-mapping: the card'],
  ['battle_boot.js', 'foe-figure: the opponent\'s figure is never mapped to a ROM trainer', 'return Number.isInteger(fig) ? trainerForFront(rom, fig) : 0;', 'return 0;', 'A3 foe-figure: an opponent'],
  ['battle_boot.js', 'foe-figure: the picture index itself is handed over as a trainer id', 'return Number.isInteger(fig) ? trainerForFront(rom, fig) : 0;', 'return Number.isInteger(fig) ? fig : 0;', 'A3 foe-figure'],
  ['trainer_figures.js', 'back-choices: stays the two genders', '  if (!frontChoices(rom).length) return [0, 1];\n', '  return [0, 1];\n', 'A4 back-choices: on this ROM'],
  ['trainer_figures.js', 'back-choices: an unmeasured ROM gets every index too', '  if (!frontChoices(rom).length) return [0, 1];\n', '', 'A4 back-choices: a ROM this was not measured on'],
  ['battle_sys.js', 'rom-back: only F is written (the byte is 0 or 1, the old rule)', "ctx.gender === 'F' ? 1 : Number.isInteger(ctx.gender) && ctx.gender >= 0 && ctx.gender < TRAINER_BACK_COUNT ? ctx.gender : 0", "ctx.gender === 'F' || ctx.gender === 1 ? 1 : 0", 'B1 rom-back'],
  ['battle_sys.js', 'rom-back: an index past the ROM table is written as it is', '&& ctx.gender >= 0 && ctx.gender < TRAINER_BACK_COUNT ? ctx.gender : 0', '? ctx.gender & 255 : 0', 'B3 rom-back: an index outside'],
  ['scene.js', 'name-result: the result screen labels the player YOU whatever the name', "mineLabel: playerName.toUpperCase(), foeLabel: trainer.toUpperCase(), ...(r.recap", "mineLabel: 'YOU', foeLabel: trainer.toUpperCase(), ...(r.recap", 'C2 name-result'],
  ['scene.js', 'name-recap: the recap labels the player YOU whatever the name', "mineLabel: playerName.toUpperCase(), foeLabel: trainer.toUpperCase() });", "mineLabel: 'YOU', foeLabel: trainer.toUpperCase() });", 'C3 name-recap: the recap the scene builds'],
  ['scene.js', 'name-fallback: the scene\'s own default name is gone', "const playerName = opts.playerName || 'You';", "const playerName = opts.playerName || '';", 'C4 name-fallback'],
];
let mutantFail = 0;
if (process.env.ARENA_SKIP_MUTANTS !== '1') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-trainer-mut-'));
  try {
    const twinDir = path.join(tmp, 'twin'); fs.cpSync(JS, twinDir, { recursive: true });
    const twinFails = await suite(await loadStack(twinDir, '?twin'), { quiet: true });
    ok(twinFails.length === 0, '2. the unmutated twin (a copied tree) is quiet', twinFails.slice(0, 3).join(' | '));
    for (let i = 0; i < MUTANTS.length; i++) {
      const [file, name, from, to, expect] = MUTANTS[i];
      const dir = path.join(tmp, 'm' + i); fs.cpSync(JS, dir, { recursive: true });
      const p = path.join(dir, file), src = fs.readFileSync(p, 'utf8');
      if (src.split(from).length !== 2) { ok(false, '3. mutant "' + name + '": its snippet is not in ' + file + ' exactly once (the mutant is broken)'); mutantFail++; continue; }
      fs.writeFileSync(p, src.replace(from, () => to));
      let fails;
      try { fails = await suite(await loadStack(dir, '?m' + i), { quiet: true }); } catch (e) { fails = ['threw: ' + String(e && e.message ? e.message : e).slice(0, 100)]; }
      const named = fails.filter((x) => x.startsWith(expect));
      ok(named.length > 0, '3. mutant killed by its named check: ' + file + ' / ' + name + ' -> "' + expect + '"', fails.length ? 'it tripped only: ' + fails.slice(0, 2).join(' | ') : 'survived');
      if (!named.length) mutantFail++;
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log('mutants: ' + (MUTANTS.length - mutantFail) + '/' + MUTANTS.length + ' killed by their named check');
}
console.log('\nbattle trainer: ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
