// tools/pokemonarena_scene_test.mjs - Node test for the S1 battle stack: battle_text.js, ai.js, matchctl.js, scene.js, battle_boot.js
// (parse / resolve / scale) and the new battle_ui.js screens (party, preview, result, overlay, tags). No browser.
//
//   node tools/pokemonarena_scene_test.mjs                    run; exit 1 on any failure
//   ARENA_UPDATE_GOLDEN=1 node tools/pokemonarena_scene_test.mjs   rewrite pokemonarena/scene.golden.json (HASHES ONLY) and text_manifest.json
//   ARENA_SKIP_MUTANTS=1 ...   skip the source-mutant half
//   ARENA_ROM=<gba>  ARENA_OUT=<dir for PNG strips>
//
// WHAT IT PROVES (every group has a way to fail, shown by the mutant half below)
//   text     the catalog resolves to ROM strings (manifest offsets + SHA-1 agree with the finder), the SHA-1 is the real one, placeholder
//            roles fill, control codes are dropped, a ROM copy with one string altered changes the rendered message, zeroed text bytes
//            change it, a hash-mismatching manifest entry is refused (falls back to a FLAGGED catalog string)
//   ai       never submits an illegal choice (fuzz over three levels, 6v6 and 3v3), deterministic in its seed, reads nothing hidden (two
//            battles that differ only in the foe's hidden data give identical choices; a Proxy records every property it touches), normal
//            beats easy over 200 seeded paired games, CPU-vs-CPU always terminates
//   match    same seed + same choices -> same hash, illegal choices are refused, the wire path (submitWire) works, onLocalChoice fires
//   scene    a human path driven by presses; after every idle point the DISPLAYED hp / name / status equal the engine's; foes lead first;
//            hit tests; pointer click == cursor + A; forfeit confirm; preview pick; result options; frame goldens (hashes only)
//   boot     the URL contract: valid forms parse, hostile / malformed values are refused WITHOUT being echoed; resolveBattle round trip
//   screens  the new battle_ui screens render deterministically, from ROM bytes (zero the icon / bar / ring bytes -> pixels change)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG, scaleRGBA, newCanvas, blit } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const OUT = process.env.ARENA_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Dev-Bemental77-github-io/c5557fc3-6bdd-45f1-a13c-2116f656d0fe/scratchpad/S1/scene_test';
const GOLDEN = path.join(root, 'pokemonarena', 'scene.golden.json');
const MANIFEST = path.join(root, 'pokemonarena', 'text_manifest.json');
const UPDATE = process.env.ARENA_UPDATE_GOLDEN === '1';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0, nChecks = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 140) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); }
}
const sha1 = (...p) => { const h = crypto.createHash('sha1'); for (const x of p) h.update(x); return h.digest('hex'); };
const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
console.log('pokemonarena scene test; ROM', ROM_PATH, rom.length, 'B; node', process.version);

async function loadStack(dir, bust = '') {
  const u = (f) => pathToFileURL(path.join(dir, f)).href + bust;
  const [BT, AI, MC, SC, BO, B, T, R, E, TC, RM, RS] = await Promise.all(['battle_text.js', 'ai.js', 'matchctl.js', 'scene.js', 'battle_boot.js', 'battle_ui.js', 'tables.js', 'rules.js', 'engine.js', 'teamcode.js', 'rom.js', 'battle_resume.js'].map((f) => import(u(f))));
  return { BT, AI, MC, SC, BO, B, T, R, E, TC, RM, RS, dir };
}

/* ====================================================================================== the checks (run on any source tree) */

// Each check returns an array of failure names; the same function runs on the real tree and on every mutant.
async function core(M, romBytes, opts = {}) {
  const f = [];
  const t = (name, cond, detail) => { nChecks++; if (cond !== true) f.push(name + (detail ? ' [' + String(detail).slice(0, 100) + ']' : '')); };
  const pack = M.T.loadPack(romBytes, { verify: 'header', dexText: false });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const text = M.BT.loadBattleText(romBytes, manifest);

  /* ---- text ---- */
  t('text: sha1Hex equals node:crypto on 40 inputs', (() => { for (let n = 0; n < 40; n++) { const b = new Uint8Array(n * 7 + n % 3); for (let i = 0; i < b.length; i++) b[i] = (i * 31 + n * 17) & 255; if (M.BT.sha1Hex(b) !== sha1(b)) return false; } return true; })());
  const rep = text.report();
  t('text: every catalog entry comes from the ROM (none missing)', rep.fallback.length === 0, rep.fallback.join(','));
  t('text: every entry found through the manifest (offsets + hashes agree)', rep.bySource.manifest === rep.total, JSON.stringify(rep.bySource));
  t('text: the finder returns exactly the manifest offset for every entry', Object.keys(M.BT.MESSAGES).every((k) => { const v = M.BT.MESSAGES[k]; const src = typeof v === 'string' ? v : v.s; const reg = typeof v === 'string' ? M.BT.TEXT_REGION : (v.region || M.BT.TEXT_REGION); const h = M.BT.findMessage(romBytes, src, reg); return h[0] === manifest.strings[k].off; }));
  const scanned = M.BT.loadBattleText(romBytes, null).report();
  t('text: the finder alone resolves the same entries', scanned.bySource.scan === rep.total, JSON.stringify(scanned.bySource));
  t('text: used', text.compose('used', { subj: 'The opposing Pikachu', b3: 'Thunderbolt' }) === 'The opposing Pikachu used Thunderbolt!', text.compose('used', { subj: 'X', b3: 'Y' }));
  t('text: super effective is the ROM wording', text.compose('super') === "It's super effective!");
  t('text: stat line fills three roles', text.compose('stat.up', { subj: 'Mew', b1: 'Attack', b2: 'sharply ' }) === "Mew's Attack sharply rose!", text.compose('stat.up', { subj: 'Mew', b1: 'Attack', b2: 'sharply ' }));
  t('text: overworld placeholder {2} uses its own slot', text.compose('party.already', { subj: 'Mew' }).startsWith('Mew is already'), text.compose('party.already', { subj: 'Mew' }));
  t('text: a role nobody supplied renders ? (never a raw {id})', !/\{[0-9a-f]+\}/.test(text.compose('used', {})) && text.compose('used', {}).includes('?'), text.compose('used', {}));
  t('text: paragraph break marker survives, control codes are dropped', text.compose('fainted', { subj: 'A' }) === 'A fainted!\\p' && !/\u0000/.test(text.compose('bag.no')) && text.compose('bag.no') === "Items can't be used now.", JSON.stringify(text.compose('bag.no')));
  t('text: needle encoder is exact', (() => { const e = M.BT.encodeNeedle('A{f}<NL>B<PARA>'); return e.length === 6 && e[1] === 0xfd && e[2] === 0x0f && e[3] === 0xfe && e[5] === 0xfb; })());
  // corruption controls on a ROM copy
  {
    const hit = manifest.strings.super;
    const altered = romBytes.slice(); altered[hit.off + 5] = altered[hit.off + 5] === 0xd5 ? 0xd6 : 0xd5;           // 's' of "super" -> another letter
    const trusted = M.BT.loadBattleText(altered, manifest, { trustOffsets: true });
    t('text: altering a ROM string changes the rendered message', trusted.compose('super') !== text.compose('super') && trusted.compose('super').length === text.compose('super').length, trusted.compose('super'));
    const strict = M.BT.loadBattleText(altered, manifest);
    t('text: a manifest entry whose hash no longer matches is refused and FLAGGED', strict.source('super') === 'fallback' && strict.report().fallback.includes('super'), strict.source('super'));
    const zeroed = romBytes.slice(); zeroed.fill(0x00, hit.off, hit.off + hit.len - 1);
    const z = M.BT.loadBattleText(zeroed, manifest, { trustOffsets: true });
    t('text: zeroing a ROM string blanks the rendered message', z.compose('super').trim() === '' && text.compose('super') !== z.compose('super'), JSON.stringify(z.compose('super')));
    const twin = M.BT.loadBattleText(romBytes.slice(), manifest);
    t('text: the unmutated twin stays quiet', twin.compose('super') === text.compose('super') && twin.report().fallback.length === 0);
  }

  /* ---- teams + matchctl ---- */
  {
    let allOk = true, why = '';
    for (let i = 1; i <= 12; i++) {
      const tm = M.MC.randomTeam(pack, i * 31, 6);
      const v = M.R.validateTeam(tm.recs.map((r) => ({ ...r, moves: r.moves.map((x) => x.id) })), pack, 'arena-gen3-standard');
      if (!v.ok || tm.recs.length !== 6 || new Set(tm.recs.map((r) => pack.species[r.species].natDex)).size !== 6) { allOk = false; why = JSON.stringify(v.reasons).slice(0, 120); break; }
    }
    t('match: random teams are legal, six distinct species, and the same seed gives the same team', allOk && JSON.stringify(M.MC.randomTeam(pack, 99, 6)) === JSON.stringify(M.MC.randomTeam(pack, 99, 6)) && JSON.stringify(M.MC.randomTeam(pack, 99, 6)) !== JSON.stringify(M.MC.randomTeam(pack, 100, 6)), why);
  }
  const mkCtl = (seed, pick, sides, o = {}) => {
    const A = M.MC.randomTeam(pack, seed * 1000 + 1, 6), B = M.MC.randomTeam(pack, seed * 1000 + 2, 6);
    const ctl = M.MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: seed * 77, pick, names: ['You', 'CPU'], sides: sides || [{ kind: 'human' }, { kind: 'cpu', level: o.level || 'normal', seed: seed + 5 }] });
    return { ctl, A, B };
  };
  {
    const a = mkCtl(3, 0, [{ kind: 'cpu', level: 'normal', seed: 1 }, { kind: 'cpu', level: 'hard', seed: 2 }]).ctl.start();
    const b = mkCtl(3, 0, [{ kind: 'cpu', level: 'normal', seed: 1 }, { kind: 'cpu', level: 'hard', seed: 2 }]).ctl.start();
    const c = mkCtl(4, 0, [{ kind: 'cpu', level: 'normal', seed: 1 }, { kind: 'cpu', level: 'hard', seed: 2 }]).ctl.start();
    t('match: CPU vs CPU terminates with a winner', a.winner !== null && c.winner !== null);
    t('match: same seeds -> identical final hash and event log', a.battle.hash() === b.battle.hash() && a.battle.logHash() === b.battle.logHash());
    t('match: different seed -> different battle', a.battle.hash() !== c.battle.hash());
  }
  {
    const { ctl } = mkCtl(5, 0);
    const heard = []; ctl.onLocalChoice((e) => heard.push(e));
    ctl.start();
    const req = ctl.pending(0);
    t('match: the human side gets a request after start', req && req.phase === 'move', JSON.stringify(req).slice(0, 80));
    t('match: an illegal choice is refused', ctl.submit(0, { kind: 'move', slot: 9 }).ok === false && ctl.submit(0, { kind: 'bogus' }).ok === false && ctl.submit(2, { kind: 'forfeit' }).ok === false);
    const turn0 = ctl.turn;
    const r = ctl.submit(0, { kind: 'move', slot: req.moves.find((m) => !m.disabled).slot });
    t('match: a legal choice advances the turn (the CPU answered by itself)', r.ok && (ctl.turn > turn0 || ctl.winner !== null), 'turn ' + ctl.turn);
    t('match: onLocalChoice fired once with the wire form', heard.length === 1 && Number.isInteger(heard[0].wire) && M.E.decodeChoice(heard[0].wire).kind === 'move');
    t('match: events were queued for the scene', ctl.takeEvents().length > 3 && ctl.takeEvents().length === 0);
  }
  {
    const { ctl } = mkCtl(6, 0, [{ kind: 'human' }, { kind: 'remote' }]);
    ctl.start();
    const r0 = ctl.pending(0), r1 = ctl.pending(1);
    t('match: a remote seat waits for submitWire', r0 && r1 && ctl.submit(0, { kind: 'move', slot: r0.moves[0].slot }).ok && ctl.turn === 1 && ctl.pending(1) !== null);
    const slot = ctl.pending(1).moves.find((m) => !m.disabled).slot;
    t('match: submitWire plays the remote choice', ctl.submitWire(M.E.encodeChoice({ kind: 'move', slot })).ok && (ctl.turn >= 2 || ctl.winner !== null || (ctl.pending(0) && ctl.pending(0).phase === 'switch') || (ctl.pending(1) && ctl.pending(1).phase === 'switch')), 'turn ' + ctl.turn);   // the turn may also end in a faint: the replacement request then waits (round 2 changed the legal pool, hence the seeded teams)
    t('match: a bad wire value is refused', ctl.submitWire(0xffff).ok === false);
  }
  {
    // 3v3 preview: both sides pick through the same path
    const { ctl } = mkCtl(7, 3);
    ctl.start();
    const rq = ctl.pending(0);
    t('match: 3v3 opens with a preview request carrying six Pokemon and pick 3', rq && rq.phase === 'preview' && rq.pick === 3 && rq.team.length === 6);
    t('match: the preview order is validated', ctl.submit(0, { kind: 'preview', order: [0, 1] }).ok === false && ctl.submit(0, { kind: 'preview', order: [0, 0, 1] }).ok === false && ctl.submit(0, { kind: 'preview', order: [4, 2, 0] }).ok === true);
    t('match: after both previews the battle starts with the chosen lead', ctl.battle.s.sides[0].team[0].orig === 4 && ctl.pending(0).phase === 'move');
  }

  /* ---- AI ---- */
  {
    let illegal = 0, games = 0, notDone = 0;
    for (const level of ['easy', 'normal', 'hard']) for (const pick of [0, 3]) for (let i = 1; i <= (opts.fast ? 3 : 8); i++) {
      const c = mkCtl(i + 40, pick, [{ kind: 'cpu', level, seed: i }, { kind: 'cpu', level: level === 'hard' ? 'easy' : 'hard', seed: i + 9 }]);
      try { c.ctl.start(); } catch (e) { illegal++; continue; }
      games++; if (c.ctl.winner === null) notDone++;
    }
    t('ai: no illegal choice and every game ends (3 levels x 6v6 / 3v3)', illegal === 0 && notDone === 0 && games > 0, `illegal ${illegal} unfinished ${notDone}`);
  }
  {
    const choiceTrace = (seed, level) => { const { ctl } = mkCtl(8, 0, [{ kind: 'cpu', level, seed }, { kind: 'cpu', level: 'normal', seed: 3 }]); ctl.start(); return JSON.stringify(ctl.battle.choiceLog); };
    t('ai: deterministic in its seed', choiceTrace(11, 'hard') === choiceTrace(11, 'hard') && choiceTrace(11, 'normal') === choiceTrace(11, 'normal'));
    t('ai: the seed matters', choiceTrace(11, 'normal') !== choiceTrace(12, 'normal') || choiceTrace(11, 'easy') !== choiceTrace(13, 'easy'));
  }
  {
    // fairness 1: identical views, different hidden foe data -> identical choices
    let same = 0, total = 0;
    for (let i = 1; i <= (opts.fast ? 4 : 10); i++) {
      const A = M.MC.randomTeam(pack, i * 17, 6), B1 = M.MC.randomTeam(pack, i * 17 + 1, 6);
      const B2 = { recs: B1.recs.map((r) => ({ ...r, evs: { hp: 0, atk: 4, def: 0, spa: 0, spd: 0, spe: 0 }, item: 0, nature: (r.nature + 7) % 25, moves: r.moves.slice().reverse() })), meta: B1.meta };
      const mk = (B) => M.E.createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: 5, pick: 0, validate: false, names: ['a', 'b'] });
      const b1 = mk(B1), b2 = mk(B2);
      // the foe's full-HP active Pokemon: the species is the same, everything unrevealed differs -> viewFor(0) must be identical
      const v1 = JSON.stringify(b1.viewFor(0)), v2 = JSON.stringify(b2.viewFor(0));
      for (const level of ['easy', 'normal', 'hard']) {
        total++;
        const a1 = M.AI.createAi({ pack, level, seed: i }), a2 = M.AI.createAi({ pack, level, seed: i });
        const c1 = a1.choose(b1.requests()[0], b1.viewFor(0), {}), c2 = a2.choose(b2.requests()[0], b2.viewFor(0), {});
        if (v1 === v2 && JSON.stringify(c1) === JSON.stringify(c2)) same++;
      }
    }
    t('ai: identical views (foe hidden data differs) give identical choices', total > 0 && same === total, same + '/' + total);
  }
  {
    // fairness 2: record every property the AI touches on view and request
    const seen = new Set();
    const spy = (o, path) => new Proxy(o, { get(tg, k, rc) { if (typeof k === 'string') seen.add(path + '.' + (/^\d+$/.test(k) ? '#' : k)); const v = Reflect.get(tg, k, rc); return v && typeof v === 'object' ? spy(v, path + '.' + (/^\d+$/.test(k) ? '#' : String(k))) : v; } });
    const { ctl } = mkCtl(9, 0);
    ctl.start();
    for (const level of ['normal', 'hard']) { const ai = M.AI.createAi({ pack, level, seed: 4 }); ai.choose(spy(ctl.pending(0), 'req'), spy(ctl.view(0), 'view'), {}); }
    const bad = [...seen].filter((p) => /^view\.foe\.team\.#\.(hp|max|stats|mv|ab|it)$/.test(p) || /^view\.foe\.activeDetail\.(hp|max|stats|mv|ab|it)$/.test(p) || /^view\.foe\.activeDetail\.revealed\.#/.test(p) === false && /^view\.foe\.activeDetail\.(stats|mv)/.test(p));
    t('ai: touches no hidden foe field (property allow-list)', bad.length === 0 && seen.size > 10, bad.join(',') + ' (' + seen.size + ' properties touched)');
  }
  {
    // strength: normal beats easy over paired games (teams swapped), hard beats easy
    const N = opts.fast ? 20 : 100;
    const wins = (lx, ly) => { let X = 0, Y = 0; for (let i = 1; i <= N; i++) { const A = M.MC.randomTeam(pack, i * 1000 + 1, 6), B = M.MC.randomTeam(pack, i * 1000 + 2, 6); for (const [p, q] of [[A, B], [B, A]]) { const ctl = M.MC.createMatchController({ pack, teams: [p.recs, q.recs], seed: i * 77, pick: 0, names: ['a', 'b'], sides: [{ kind: 'cpu', level: lx, seed: i }, { kind: 'cpu', level: ly, seed: i + 50 }] }); ctl.start(); if (ctl.winner === 0) X++; else if (ctl.winner === 1) Y++; } } return { X, Y, pct: 100 * X / Math.max(1, X + Y) }; };
    const ne = wins('normal', 'easy');
    t('ai: normal beats easy over ' + 2 * N + ' paired games (>= 70%)', ne.pct >= 70, JSON.stringify(ne));
    if (!opts.fast) {
      const he = wins('hard', 'easy'); t('ai: hard beats easy (>= 70%)', he.pct >= 70, JSON.stringify(he));
      const hn = wins('hard', 'normal');
      t('ai: the ladder is real: hard beats NORMAL over ' + 2 * N + ' paired side-swapped games (>= 56%; measured 59.7% [57.5, 61.8] over 2000 held-out games)', hn.pct >= 56, JSON.stringify(hn));
      t('ai: ...and hard is stronger than normal against the same easy opponent', he.pct > ne.pct, 'hard ' + he.pct.toFixed(1) + '% vs normal ' + ne.pct.toFixed(1) + '%');
      core.strength = { ne, he, hn };
    }
  }
  {
    // consistency: the CPU levels differ in how often they play something other than their best move. A decision point is a real
    // (request, view) pair from a CPU-vs-CPU battle; asking the same level with 8 different seeds must give ONE answer for hard (it has no
    // deliberate blunders; only exact ties are broken by the seed) and several answers for normal (it slips) and easy (it is random).
    const pts = [];
    for (let i = 1; i <= (opts.fast ? 8 : 24); i++) {
      const A = M.MC.randomTeam(pack, i * 1000 + 1, 6), B = M.MC.randomTeam(pack, i * 1000 + 2, 6);
      const c = M.MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: i * 77, pick: 0, names: ['a', 'b'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: i + 50 }] });
      c.start(); const drv = M.AI.createAi({ pack, level: 'hard', seed: i });
      for (let g = 0; c.winner === null && g < 400; g++) {
        const req = c.pending(0); if (!req) break;
        if (req.phase === 'move' && !req.struggle) pts.push({ req: JSON.parse(JSON.stringify(req)), view: JSON.parse(JSON.stringify(c.view(0))) });
        const ch = drv.choose(req, c.view(0), {}); const r = c.submit(0, ch); if (!r.ok) break;
      }
    }
    const agree = (level) => { let same = 0; for (const q of pts) { const set = new Set(); for (let sd = 1; sd <= 8; sd++) set.add(JSON.stringify(M.AI.createAi({ pack, level, seed: sd * 13 + 1 }).choose(q.req, q.view, {}))); if (set.size === 1) same++; } return same / Math.max(1, pts.length); };
    const ah = agree('hard'), an = agree('normal'), ae = agree('easy');
    t('ai: consistency over ' + pts.length + ' real decision points: hard answers the same for 8 seeds in >= 98% (got ' + (100 * ah).toFixed(1) + '%)', pts.length >= 60 && ah >= 0.98, ah.toFixed(3));
    t('ai: ...normal does not (< 75%, it slips: got ' + (100 * an).toFixed(1) + '%) and easy even less (got ' + (100 * ae).toFixed(1) + '%)', an < 0.75 && ae < an + 0.02, an.toFixed(3) + ' / ' + ae.toFixed(3));
  }

  /* ---- scene: a driven human path ---- */
  const ui = M.B.createBattleUi(romBytes);
  const engineActive = (ctl, side) => { const s = ctl.battle.s.sides[side]; const m = s.team[s.act]; return m; };
  const check = (scene, ctl, tag, problems) => {
    const st = scene.state();
    const mine = engineActive(ctl, 0), foe = engineActive(ctl, 1);
    if (st.mode === 'action' || st.mode === 'result' || st.mode === 'party' || st.mode === 'preview') {
      if (st.player && mine && !(st.player.name === mine.name && st.player.hp === mine.hp && st.player.max === mine.mhp)) problems.push(tag + ': player ' + JSON.stringify(st.player) + ' vs engine ' + mine.name + ' ' + mine.hp + '/' + mine.mhp);
      if (st.foe && foe && !(st.foe.name === foe.name && st.foe.hp === foe.hp && st.foe.max === foe.mhp)) problems.push(tag + ': foe ' + JSON.stringify(st.foe) + ' vs engine ' + foe.name + ' ' + foe.hp + '/' + foe.mhp);
      const lab = { 0: null, 1: 'SLP', 2: 'PSN', 3: 'BRN', 4: 'FRZ', 5: 'PAR', 6: 'PSN' };
      if (st.player && mine && mine.hp > 0 && st.player.status !== lab[mine.s]) problems.push(tag + ': player status ' + st.player.status + ' vs ' + mine.s);
      if (st.foe && foe && foe.hp > 0 && st.foe.status !== lab[foe.s]) problems.push(tag + ': foe status ' + st.foe.status + ' vs ' + foe.s);
    }
  };
  const driveHuman = (seed, pick, level, opt = {}) => {
    const { ctl, A, B } = mkCtl(seed, pick, null, { level });
    if (opt.onCtl) opt.onCtl(ctl);
    const text = M.BT.loadBattleText(romBytes, manifest);
    const hooks = { sendouts: [], faints: [], hits: 0 };
    const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You', hooks: { onSendOut: (s, sp) => hooks.sendouts.push([s, sp]), onFaint: (s) => hooks.faints.push(s), onHit: () => { hooks.hits++; } } });
    ctl.start(); scene.begin();
    const problems = [], modes = new Set(), texts = [];
    let frames = 0, last = null, rnd = seed * 7 + 1;
    const rand = (n) => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return (rnd >>> 8) % n; };
    const max = opt.maxFrames || 160000;
    while (scene.mode !== 'result' && frames++ < max) {
      scene.tick();
      const c = scene.S.cur;
      if (c && c.t === 'text' && c !== last) { last = c; texts.push(c.text); }
      const m = scene.mode; modes.add(m);
      if (m === 'preview') { const p = scene.S.preview; if (p.picks.length < p.pick) { scene.press('a'); if (scene.mode === 'preview') scene.press('down'); } }
      else if (m === 'confirm') { if (scene.S.confirm.kind === 'team') scene.press('a'); }
      else if (m === 'action') { if (opt.stopAtTurn && ctl.turn >= opt.stopAtTurn) break; check(scene, ctl, 'action t' + ctl.turn, problems); const r = rand(40); if (r === 0 && opt.forfeitAt && ctl.turn >= opt.forfeitAt) { scene.press('down'); scene.press('right'); scene.press('a'); scene.press('up'); scene.press('a'); } else scene.press('a'); }
      else if (m === 'moves') { const rows = scene.S.req.moves; let k = rand(rows.length); for (let g = 0; g < 4 && rows[k].disabled; g++) k = (k + 1) % rows.length; for (let g = 0; g < 8 && scene.S.moveCursor !== k; g++) scene.press(scene.S.moveCursor < k ? (k - scene.S.moveCursor === 1 && (k & 1) ? 'right' : 'down') : (scene.S.moveCursor - k === 1 && !(k & 1) ? 'left' : 'up')); scene.press('a'); }
      else if (m === 'party') { check(scene, ctl, 'party t' + ctl.turn, problems); scene.press('a'); }
      else if (m === 'steps' && frames % 97 === 0) scene.press('a');
      if (scene.mode === 'result') check(scene, ctl, 'result', problems);
    }
    return { scene, ctl, problems, modes, texts, frames, hooks, A, B };
  };
  {
    let probs = [], done = 0, all = new Set(), anyTexts = [], sends = 0, faints = 0, hits = 0;
    for (const [seed, pick, level] of opts.fast ? [[1, 0, 'normal']] : [[1, 0, 'normal'], [2, 3, 'normal'], [3, 0, 'hard'], [4, 3, 'easy'], [5, 0, 'normal'], [6, 3, 'hard']]) {
      const r = driveHuman(seed, pick, level);
      probs = probs.concat(r.problems); if (r.scene.mode === 'result') done++;
      r.modes.forEach((m) => all.add(m)); anyTexts = anyTexts.concat(r.texts); sends += r.hooks.sendouts.length; faints += r.hooks.faints.length; hits += r.hooks.hits;
      t('scene: seed ' + seed + ' ends on the result screen with the engine winner', r.scene.mode === 'result' && r.ctl.winner !== null, 'mode ' + r.scene.mode + ' frames ' + r.frames);
      const lead = r.texts.slice(0, 4);
      t('scene: seed ' + seed + ' opens with the challenge, the FOE send-out, then the player send-out', /would like to battle/.test(lead[0]) && /sent out/.test(lead[1]) && /^(Go!|You're in charge|Go for it|Your opponent)/.test(lead[2]), JSON.stringify(lead));
    }
    t('scene: displayed hp / name / status equal the engine at every idle point', probs.length === 0, probs.slice(0, 3).join(' | '));
    t('scene: every kind of screen appeared (action, moves, party, preview or steps)', ['action', 'moves', 'party', 'steps'].every((m) => all.has(m)), [...all].join(','));
    t('scene: hooks fired (send-outs, faints, hits)', sends >= 4 && faints >= 2 && hits >= 4, `${sends}/${faints}/${hits}`);
    t('scene: messages include ROM combat lines', anyTexts.some((s) => / used /.test(s)) && anyTexts.some((s) => /fainted!/.test(s)), anyTexts.slice(0, 3).join(' / '));
    t('scene: no message contains a raw placeholder or an unfilled role', !anyTexts.some((s) => /\{[0-9a-f]{1,2}\}|undefined|\[object/.test(s)), anyTexts.find((s) => /\{[0-9a-f]{1,2}\}|undefined/.test(s)));
  }
  {
    // forfeit through the menus
    const r = driveHuman(21, 0, 'normal', { forfeitAt: 2, maxFrames: 200000 });
    t('scene: forfeit through RUN -> YES ends the battle in a loss', r.scene.mode === 'result' && r.ctl.winner === 1 && r.texts.some((s) => /forfeit/i.test(s)), r.ctl.winner + ' ' + r.texts.slice(-3).join('/'));
  }
  {
    // W1 fix D1: MASHING A / clicking / tapping through the end of a battle must not start REMATCH (or anything) before the result screen has been readable
    let allHeld = true, allFired = true, n = 0;
    for (const [seed, pick, level] of opts.fast ? [[1, 0, 'normal']] : [[1, 0, 'normal'], [2, 3, 'easy'], [3, 0, 'hard']]) {
      const r = driveHuman(seed, pick, level, { maxFrames: 200000 });
      if (r.scene.mode !== 'result') continue;
      n++;
      const fired = [];
      r.scene.hooks.onResult = (o) => fired.push(o);
      const R = r.scene.S.result;
      const g = M.SC.RESULT_GUARD_FRAMES;
      for (let f = 0; f < g - 5; f++) {                          // mash A every 5 frames, and click / tap the first option, until just before the guard ends
        r.scene.tick();
        if (f % 5 === 0) { r.scene.press('a'); r.scene.choose.result(0); }
      }
      if (fired.length || r.scene.mode !== 'result') allHeld = false;
      for (let f = 0; f < 10; f++) r.scene.tick();
      r.scene.press('a');                                          // a press AFTER the guard chooses what the cursor is on
      if (fired.length !== 1 || fired[0] !== R.options[0]) allFired = false;
    }
    t('scene: mashing A and clicking through the result screen starts nothing for ' + M.SC.RESULT_GUARD_FRAMES + ' frames, in ' + n + ' finished battles', n > 0 && allHeld, 'a choice fired inside the guard');
    t('scene: a press after the guard chooses the option under the cursor, once', n > 0 && allFired, 'no (or more than one) choice after the guard');
    {   // W1 fix D3: leaving from the pause menu at the TEAM PREVIEW asks YES / NO over the preview (it used to draw it over an empty sea)
      const { ctl, A, B } = mkCtl(30, 3);
      const text = M.BT.loadBattleText(romBytes, manifest);
      const sc = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You' });
      ctl.start(); sc.begin();
      let g = 0; while (sc.mode !== 'preview' && g++ < 20000) sc.tick();
      sc.press('start');
      const rows = sc.S.menu ? sc.S.menu.rows.slice() : [];
      for (let k = 0; k < rows.length - 1; k++) sc.press('down');
      sc.press('a');
      const v = sc.view();
      t('scene: BACK TO HUB / QUIT at the team preview keeps the preview behind its YES / NO', sc.mode === 'confirm' && sc.S.confirm.kind === 'quit' && v.screen === 'preview' && /Leave this battle/.test(v.preview.title) && !!v.overlay && v.overlay.rows.join() === 'YES,NO', JSON.stringify(v.screen) + ' ' + sc.mode);
      sc.press('b');
      t('scene: NO returns to the team preview', sc.mode === 'preview');
    }
  }
  {
    // W1 fix D11: RELOADING MID-BATTLE RESUMES IT. A live game is played to turn 3; a "reloaded page" replays the saved choices into a fresh controller and the scene plays the history at speed.
    const mem = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
    const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
    const text = M.BT.loadBattleText(romBytes, manifest);
    const sn = 47, bseed = sn * 77, key = M.RS.resumeKey('/pokemonarena/battle.html', '?seed=' + bseed);
    const fresh = () => mkCtl(sn, 3, null, { level: 'normal' });                       // the same address -> the same teams, seed and CPU
    const stA = mem(), rsA = M.RS.createResumeStore({ storage: stA, key, seed: bseed });
    const live = driveHuman(sn, 3, 'normal', { stopAtTurn: 3, maxFrames: 300000, onCtl: (c) => rsA.attach(c) });
    await flush();
    const rec = stA.getItem(key) ? JSON.parse(stA.getItem(key)) : null;
    const nHuman = live.ctl.info().choiceLog.filter((e) => e.s === 0).length;
    t('resume: a live game played to turn 3 left a record of its ' + nHuman + ' human choices and the state hash', live.scene.mode === 'action' && live.ctl.turn >= 3 && !!rec && M.RS.validRecord(rec, bseed) && rec.choices.length === nHuman && nHuman >= 4 && rec.hash === live.ctl.battle.hash(), JSON.stringify(rec).slice(0, 120));
    const redo = (navType, storage = stA, over = {}) => {
      const f = fresh(); f.ctl.start();
      const store = M.RS.createResumeStore({ storage, key, seed: bseed, ...over });
      return { f, out: store.restore({ ctl: f.ctl, makeCtl: () => { const g = fresh(); return g.ctl; }, navType }) };
    };
    const startedHash = (() => { const f = fresh(); f.ctl.start(); return f.ctl.battle.hash(); })();
    const rr = redo('reload');
    t('resume: a reload replays the saved choices into the SAME battle (hash, turn, choice log)', rr.out.info.restored && rr.out.ctl.battle.hash() === live.ctl.battle.hash() && rr.out.ctl.turn === live.ctl.turn && JSON.stringify(rr.out.ctl.info().choiceLog) === JSON.stringify(live.ctl.info().choiceLog), JSON.stringify(rr.out.info));
    {
      const sc2 = M.SC.createScene({ ui, pack, text, ctl: rr.out.ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [rr.f.A.meta, rr.f.B.meta], trainer: 'CPU', playerName: 'You' });
      sc2.begin();
      const frames = sc2.catchUp();
      const a = sc2.state(), b = live.scene.state();
      const sameMon = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      t('resume: the resumed scene stands on the action menu of the same turn with the same Pokemon, HP, status and weather as the live game', sc2.mode === 'action' && a.turn === b.turn && sameMon(a.player, b.player) && sameMon(a.foe, b.foe) && a.weather === b.weather && frames > 100, JSON.stringify({ am: a.mode, bm: b.mode, at: a.turn, bt: b.turn, ap: a.player, bp: b.player, af: a.foe, bf: b.foe, frames }));
      t('resume: ... and it can be played on (the next choice is accepted and the battle goes on)', (() => { sc2.press('a'); sc2.press('a'); let g = 0; while ((sc2.mode === 'steps') && g++ < 60000) sc2.tick(); return rr.out.ctl.turn === b.turn + 1 || sc2.mode === 'party' || sc2.mode === 'result'; })(), sc2.mode + ' ' + rr.out.ctl.turn);
      t('resume: a held A does not leak out of the fast-forward', sc2.S.held.a === false && sc2.S.held.b === false);
    }
    const nav = redo('navigate');
    t('resume: a FRESH visit of the same address does not resume (the preview is the first screen) and drops the stale record', !nav.out.info.restored && nav.out.ctl.battle.hash() === startedHash && stA.getItem(key) === null, JSON.stringify(nav.out.info));
    const st1 = mem(); st1.setItem(key, JSON.stringify({ ...rec, hash: 'deadbeefdeadbeef' }));
    const bad = redo('reload', st1);
    t('resume: a record whose hash does not match the replay is refused: fresh battle, record cleared', !bad.out.info.restored && /not the saved one/.test(bad.out.info.reason) && bad.out.ctl.battle.hash() === startedHash && st1.getItem(key) === null, JSON.stringify(bad.out.info));
    const st2 = mem(); st2.setItem(key, JSON.stringify({ ...rec, choices: [{ kind: 'move', slot: 9 }, ...rec.choices.slice(1)] }));
    const ill = redo('reload', st2);
    t('resume: a record with an illegal choice is refused: fresh battle, record cleared', !ill.out.info.restored && /refused/.test(ill.out.info.reason) && ill.out.ctl.battle.hash() === startedHash && st2.getItem(key) === null, JSON.stringify(ill.out.info));
    const st3 = mem(); st3.setItem(key, JSON.stringify({ ...rec, seed: bseed + 1 }));
    const oth = redo('reload', st3);
    t('resume: a record saved for another seed is not used and is cleared', !oth.out.info.restored && st3.getItem(key) === null && oth.out.ctl.battle.hash() === startedHash, JSON.stringify(oth.out.info));
    const st4 = mem(); st4.setItem(key, '{not json');
    const junk = redo('reload', st4);
    t('resume: junk in the store is ignored (no throw), cleared, fresh battle', !junk.out.info.restored && st4.getItem(key) === null && junk.out.ctl.battle.hash() === startedHash, JSON.stringify(junk.out.info));
    const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    const blocked = redo('reload', boom);
    t('resume: storage that throws costs nothing (fresh battle, no exception)', !blocked.out.info.restored && blocked.out.ctl.battle.hash() === startedHash, JSON.stringify(blocked.out.info));
    t('resume: no storage at all (null) is fine too', (() => { const r = redo('reload', null); return !r.out.info.restored && /no session storage/.test(r.out.info.reason); })());
    {
      // the record grows by exactly one choice per local choice, saved once the engine has answered
      const { ctl: c3 } = mkCtl(43, 0); c3.start();
      const st5 = mem(), k5 = M.RS.resumeKey('/pokemonarena/battle.html', '?seed=1'), rs5 = M.RS.createResumeStore({ storage: st5, key: k5, seed: 43 * 77 });
      rs5.attach(c3);
      const ai = M.AI.createAi({ pack, level: 'normal', seed: 3 });
      const counts = [];
      for (let k = 0; k < 3 && c3.winner === null; k++) {
        const req = c3.pending(0); if (!req) break;
        c3.submit(0, ai.choose(req, c3.view(0), { previewInfo: { foe: c3.previewInfo[1] } }));
        await flush();
        const raw = st5.getItem(k5); const j = raw ? JSON.parse(raw) : null;
        counts.push(j ? j.choices.length + '@' + j.turn + (j.hash === c3.battle.hash() ? '' : '!hash') : 'none');
      }
      t('resume: after each human choice the record holds that many choices, the turn and the state hash ' + counts.join(' '), counts.length === 3 && counts.every((s, i) => s.startsWith((i + 1) + '@') && !s.includes('!')), counts.join(' '));
    }
    {
      // the end of the battle clears the record (and a late write cannot bring it back)
      const stE = mem(), rsE = M.RS.createResumeStore({ storage: stE, key, seed: bseed });
      const fin = driveHuman(sn, 3, 'normal', { maxFrames: 300000, onCtl: (c) => rsE.attach(c) });
      await flush();
      t('resume: a finished battle leaves no record behind', fin.scene.mode === 'result' && fin.ctl.winner !== null && stE.getItem(key) === null, String(stE.getItem(key)).slice(0, 80));
    }
  }
  {
    // menus, hit tests and pointer events on a fresh scene
    const { ctl, A, B } = mkCtl(30, 0);
    const text = M.BT.loadBattleText(romBytes, manifest);
    const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You' });
    ctl.start(); scene.begin();
    let g = 0; while (scene.mode === 'steps' && g++ < 5000) scene.tick();
    t('scene: opens the FIGHT / BAG / POKeMON / RUN menu', scene.mode === 'action', scene.mode);
    const R = ui.R;
    const cell = (i) => ({ x: R.menu.x + 12 + (i & 1) * 48, y: R.menu.y + 6 + (i >> 1) * 16 });
    t('scene: hit test maps the four action cells', [0, 1, 2, 3].every((i) => { const h = scene.hit(cell(i).x, cell(i).y); return h && h.kind === 'action' && h.index === i; }));
    t('scene: a point outside every cell hits nothing', scene.hit(5, 5) === null);
    const agree = () => { for (let x = 0; x < 240; x += 6) for (let y = 0; y < 160; y += 5) { const a = scene.hit(x, y), b = ui.hitTest(scene.view(), x, y); if (JSON.stringify(a) !== JSON.stringify(b)) return scene.mode + ' (' + x + ',' + y + ') scene ' + JSON.stringify(a) + ' ui ' + JSON.stringify(b); } return true; };
    t('scene: ui.hitTest (the INPUT.md contract) agrees with scene.hit over a point grid: action menu', agree() === true, agree());
    scene.pointer({ kind: 'move', x: cell(3).x, y: cell(3).y });
    t('scene: pointer hover moves the cursor without activating', scene.state().cursor === 3 && scene.mode === 'action');
    scene.pointer({ kind: 'click', x: cell(1).x, y: cell(1).y });                    // BAG
    t('scene: clicking BAG shows the ROM message and returns to the menu', scene.mode === 'steps');
    g = 0; let bagText = ''; while (g++ < 4000 && scene.mode === 'steps') { scene.tick(); if (scene.S.cur && scene.S.cur.t === 'text') bagText = scene.S.cur.text; }
    t('scene: BAG says the ROM line and the menu comes back', /Items can't be used now/.test(bagText) && scene.mode === 'action', bagText + ' / ' + scene.mode);
    scene.pointer({ kind: 'click', x: cell(0).x, y: cell(0).y });                    // FIGHT
    t('scene: clicking FIGHT opens the move menu', scene.mode === 'moves');
    const mc = (i) => ({ x: R.mv[i].x + 10, y: R.mv[i].y + 6 });
    const nm = scene.S.req.moves.length;
    t('scene: ui.hitTest agrees with scene.hit: move menu', agree() === true, agree());
    { // W1: the move menu view carries the frame counter (FA1: no name scrolls any more; the real window just clips a too-wide name)
      const t0 = scene.view().box.tick; for (let k = 0; k < 7; k++) scene.tick(); const t1 = scene.view().box.tick;
      t('scene: the move menu box carries tick, and it advances with the frames', Number.isInteger(t0) && t1 === t0 + 7, t0 + ' -> ' + t1);
    }
    t('scene: each move-menu row carries the ROM name of its type (FA1: the real window prints "TYPE/Normal", not a badge)', scene.view().box.moves.length > 0 && scene.view().box.moves.every((m) => typeof m.typeName === 'string' && m.typeName.length > 0 && m.typeName === pack.types[m.type].name));
    t('scene: hit test maps the move cells', Array.from({ length: Math.min(4, nm) }, (_, i) => i).every((i) => { const h = scene.hit(mc(i).x, mc(i).y); return h && h.kind === 'move' && h.index === i; }));
    { // W1 fix A4: touch never depends on the on-screen pad: a tap on the picture above the move menu goes back
      const hb = scene.hit(120, 20);
      t('scene: (A4) the picture above the move menu is a BACK target', !!hb && hb.kind === 'back', JSON.stringify(hb));
      { // W1 fix A5: a mouse can read a move's description: click the PP / TYPE boxes
        const ir = ui.moveInfoRect(), cx = ir.x + ir.w / 2, cy = ir.y + ir.h / 2, hi = scene.hit(cx, cy);
        t('scene: (A5) the PP / TYPE boxes beside the move menu are an INFO target', !!hi && hi.kind === 'info', JSON.stringify(hi) + ' ' + JSON.stringify(ir));
        const want = pack.moves[scene.S.req.moves[scene.state().moveCursor].id].desc;
        scene.pointer({ kind: 'click', x: cx, y: cy });
        let shown = ''; let gg = 0; while (gg++ < 4000 && scene.mode === 'steps') { scene.tick(); if (scene.S.cur && scene.S.cur.t === 'text') shown = String(scene.S.cur.text); }
        t('scene: (A5) clicking it shows the highlighted move\'s description and the move menu comes back', !!want && shown.replace(/\s+/g, ' ').slice(0, 12) === want.replace(/\s+/g, ' ').slice(0, 12) && scene.mode === 'moves', JSON.stringify(shown).slice(0, 80) + ' / ' + scene.mode);
      }
      scene.pointer({ kind: 'move', x: 120, y: 20 });
      t('scene: (A4) hovering it changes nothing', scene.mode === 'moves');
      scene.pointer({ kind: 'click', x: 120, y: 20 });
      t('scene: (A4) a tap on it goes back to the action menu', scene.mode === 'action');
      scene.pointer({ kind: 'click', x: cell(0).x, y: cell(0).y });                  // FIGHT again
    }
    scene.press('b');
    t('scene: B goes back to the action menu', scene.mode === 'action');
    scene.press('down'); scene.press('right');
    scene.press('a');                                                               // RUN
    t('scene: RUN opens the confirm with a YES / NO overlay defaulting to NO', scene.mode === 'confirm' && scene.state().overlay.join() === 'YES,NO' && scene.S.confirm.cursor === 1);
    t('scene: the confirm shows the ROM question in the message box', /give up on this battle/.test(scene.view().box.text.join(' ')) && scene.view().box.text[0].length > 5, JSON.stringify(scene.view().box.text));
    scene.press('b');
    t('scene: B on the confirm cancels', scene.mode === 'action' && ctl.winner === null);
    scene.pointer({ kind: 'click', x: cell(2).x, y: cell(2).y });                  // POKeMON
    t('scene: POKeMON opens the party screen with a cancel button', scene.mode === 'party' && scene.view().party.canCancel === true);
    const gp = ui.GEOM.party;
    const h2 = scene.hit(gp.x + 20, gp.y + gp.pitch * 2 + 8);
    t('scene: party rows hit test', h2 && h2.kind === 'party' && h2.index === 2, JSON.stringify(h2));
    t('scene: ui.hitTest agrees with scene.hit: party screen', agree() === true, agree());
    scene.press('b');
    t('scene: B leaves the party screen', scene.mode === 'action');
    scene.press('start');
    t('scene: START opens the menu overlay (resume / sound / forfeit / quit)', scene.mode === 'menu' && scene.state().overlay.length === 4, JSON.stringify(scene.state().overlay));
    scene.press('start');
    t('scene: START again closes it', scene.mode === 'action');
    { // W1 fix A4: a tap beside an open pause menu closes it (RESUME); a tap beside a YES / NO answers NO
      scene.press('start');
      const hm = scene.hit(8, 150);
      t('scene: (A4) beside the pause menu is a BACK target', scene.mode === 'menu' && !!hm && hm.kind === 'back', JSON.stringify(hm));
      t('scene: (A4) ui.hitTest agrees with scene.hit beside the pause menu', agree() === true, agree());
      scene.pointer({ kind: 'click', x: 8, y: 150 });
      t('scene: (A4) a tap beside the pause menu closes it', scene.mode === 'action');
      scene.pointer({ kind: 'click', x: cell(3).x, y: cell(3).y });                   // RUN -> YES / NO
      t('scene: (A4) (setup) RUN asks YES / NO', scene.mode === 'confirm');
      t('scene: (A4) ui.hitTest agrees with scene.hit beside the YES / NO box', agree() === true, agree());
      scene.pointer({ kind: 'click', x: 8, y: 20 });
      t('scene: (A4) a tap beside the YES / NO answers NO (nothing is forfeited)', scene.mode === 'action' && ctl.winner === null);
    }
    // wheel steps
    const c0 = scene.state().cursor;
    scene.pointer({ kind: 'wheel', steps: 1 });
    t('scene: the wheel steps the cursor down the action menu', scene.state().cursor === (c0 ^ 2), c0 + ' -> ' + scene.state().cursor);
  }
  {
    // team preview flow by pointer
    const { ctl, A, B } = mkCtl(31, 3);
    const text = M.BT.loadBattleText(romBytes, manifest);
    const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You' });
    ctl.start(); scene.begin(); scene.tick();
    t('scene: 3v3 starts on the team preview', scene.mode === 'preview');
    // S1 verifier minor 3: the pause menu's FORFEIT used to forfeit instantly from the team preview (RUN asks first)
    scene.press('start'); scene.press('down'); scene.press('down'); scene.press('a');
    t('scene: START > FORFEIT at the team preview opens the YES / NO confirm and does not forfeit', scene.mode === 'confirm' && ctl.winner === null && scene.state().overlay.join() === 'YES,NO', scene.mode + ' winner ' + ctl.winner);
    scene.press('b');
    t('scene: NO on that confirm returns to the team preview with the battle still on', scene.mode === 'preview' && ctl.winner === null, scene.mode);
    const G = ui.GEOM.preview.mine;
    const click = (i) => scene.pointer({ kind: 'click', x: G.x + 30, y: G.y + i * G.pitch + 10 });
    click(4); click(1); click(1);
    t('scene: clicking a row picks it, clicking it again un-picks it', scene.state().picks.join() === '4');
    click(2); click(0);
    t('scene: three picks open the confirm overlay', scene.mode === 'confirm' && scene.state().picks.join() === '4,2,0', scene.mode + ' ' + scene.state().picks);
    scene.press('b');
    t('scene: NO clears the picks and returns to the preview', scene.mode === 'preview' && scene.state().picks.length === 0);
    click(5); click(3); click(1); scene.press('a');
    let g = 0; while ((scene.mode === 'steps' || scene.mode === 'confirm') && g++ < 20000) scene.tick();
    t('scene: YES submits the order and the battle begins with the first pick leading', scene.mode === 'action' && ctl.battle.s.sides[0].team[0].orig === 5 && scene.state().player.name === ctl.battle.s.sides[0].team[0].name, scene.mode);
  }

  /* ---- screens ---- */
  {
    const mons = [25, 6, 130, 94, 143, 149].map((id, i) => ({ species: id, name: pack.species[id].name, level: 50, hp: [110, 60, 12, 0, 190, 140][i], maxHp: [110, 153, 170, 130, 190, 150][i], status: [null, 'BRN', null, null, 'SLP', 'PAR'][i], gender: 'M', shiny: false, fainted: i === 3, active: i === 0 }));
    const views = {
      party: { screen: 'party', party: { mons, cursor: 1, tick: 0, prompt: ['Choose a', 'Pokemon.'], canCancel: true } },
      preview: { screen: 'preview', preview: { mine: mons, foe: mons.slice().reverse(), picks: [2, 0], cursor: 1, tick: 0, title: 'Choose 3 (2/3)', foeTitle: 'CPU', prompt: [] } },
      result: { screen: 'result', result: { head: ['You defeated CPU!', ''], mine: mons, foe: mons, options: ['REMATCH', 'NEW BATTLE', 'LEAVE'], cursor: 0, tick: 0 } },
      overlay: { env: 0, foe: { species: 129, name: 'Magikarp', level: 50, hp: 40, maxHp: 80, status: null, gender: 'M' }, player: { species: 25, name: 'Pikachu', level: 50, hp: 110, maxHp: 110, status: 'PAR', gender: 'M' }, box: { mode: 'message', text: ['Hi', ''] }, tags: ['RAIN'], overlay: { rows: ['YES', 'NO'], cursor: 1, w: 56 } },
    };
    const px = (v, u = ui) => sha1(u.render(v).rgba);
    const base = {}; for (const k of Object.keys(views)) base[k] = px(views[k]);
    t('screens: rendering is a pure function of the view', Object.keys(views).every((k) => px(views[k]) === base[k]));
    t('screens: the four views differ from each other', new Set(Object.values(base)).size === 4);
    const corrupt = (fn) => { const r = romBytes.slice(); fn(r); return M.B.createBattleUi(r); };
    const SG = await import(pathToFileURL(path.join(M.dir, 'speciesgfx.js')).href);
    const rec = SG.speciesRecord(romBytes, 25);
    // each asset the screens draw has its own ROM bytes: the HP-bar strip tiles, the species' icon palette, the window palette (ring + panels)
    const zeroFont = corrupt((r) => { r.fill(0, 0x626524 + 161 * 64, 0x626524 + 256 * 64); });
    t('screens: zeroing the ROM font glyphs changes the party screen', px(views.party, zeroFont) !== base.party);
    const zeroHp = corrupt((r) => { r.fill(0, 7471840, 7471840 + 0x120); });
    t('screens: zeroing the ROM HP-bar tiles changes the party screen', px(views.party, zeroHp) !== base.party);
    const zeroIcon = corrupt((r) => { r.fill(0, rec.iconPal, rec.iconPal + 32); });
    t('screens: changing the ROM icon palette changes the party screen', px(views.party, zeroIcon) !== base.party);
    const zeroWin = corrupt((r) => { r.fill(0, 7577904, 7577904 + 64); r.fill(0, 0x111b8d8, 0x111b8d8 + 32); });          // FA1: window-ring colours now come from the window-frame palette 0x111b8d8 (bank 1) as well as 0x73a130 (bank 0)
    t('screens: zeroing the ROM textbox palette (window rings) changes the party, result and overlay windows', px(views.party, zeroWin) !== base.party && px(views.result, zeroWin) !== base.result && px(views.overlay, zeroWin) !== base.overlay);
    const zeroStatus = corrupt((r) => { r.fill(0, 6965428, 6965428 + 32); });
    t('screens: zeroing the ROM status-icon palette changes the party screen (its status icons)', px(views.party, zeroStatus) !== base.party);
    // the party / preview / result backgrounds and panels are the ROM party-menu bg art: its palette (ROM 0x73c650) recolours all three and none of the battle view
    const zeroPM = corrupt((r) => { r.fill(0, 0x73c650, 0x73c650 + 512); });
    t('screens: zeroing the ROM party-menu palette changes the party, preview and result screens', px(views.party, zeroPM) !== base.party && px(views.preview, zeroPM) !== base.preview && px(views.result, zeroPM) !== base.result);
    t('screens: ...and leaves the battle view untouched (control)', px(views.overlay, zeroPM) === base.overlay);
    const zeroHb = corrupt((r) => { for (let k = 1; k < 16; k++) { r[0x72140c + k * 2] = 0xe0; r[0x72140c + k * 2 + 1] = 0x03; } });
    t('screens: the weather tag plate is ROM healthbox art (recolouring the ROM healthbox palette recolours it)', px(views.overlay, zeroHb) !== base.overlay && px({ ...views.overlay, tags: [] }, zeroHb) !== px(views.overlay, zeroHb));
    const twin = corrupt(() => {});
    t('screens: the unmutated twin renders identically', Object.keys(views).every((k) => px(views[k], twin) === base[k]));
    t('screens: a weather tag draws only on the battle view', px({ ...views.overlay, tags: [] }) !== base.overlay);
    t('screens: overlay rects line up with the drawn rows', (() => { const g = ui.overlayRects(views.overlay.overlay); return g.rows.length === 2 && g.rows[1].y === g.rows[0].y + 16 && g.win.h === 32; })());
  }

  /* ---- boot: URL contract ---- */
  {
    const P = M.BO.parseBattleQuery;
    const good = P('?seed=7&format=3v3&cpu=hard');
    t('boot: valid parameters parse', good.ok && good.params.seed === 7 && good.params.format === '3v3' && good.params.cpu === 'hard' && good.params.foe === 'random' && good.params.quick === true);
    t('boot: no parameters = Quick Battle 3v3 / normal', (() => { const r = P(''); return r.ok && r.params.quick && r.params.format === '3v3' && r.params.cpu === 'normal' && r.params.team === null && r.params.seed === null; })());
    t('boot: a team code selects 6v6 by default', P('?team=ARENA1.abc_-.0a1F').ok && P('?team=ARENA1.abc_-.0a1F').params.format === '6v6');
    const hostile = ['?team=%3Cscript%3Ealert(1)%3C%2Fscript%3E', '?team=ARENA1.x.zzzz', '?team=' + 'A'.repeat(5000), '?team=javascript:alert(1)', '?team=ARENA1.abc.0000%00', '?foe=ARENA2.abc.0000', '?foe=../../etc/passwd', '?seed=-1', '?seed=4294967296', '?seed=1e3', '?seed=0x10', '?seed=', '?format=9v9', '?format=3V3', '?cpu=impossible', '?cpu=', '?speed=turbo'];
    t('boot: every hostile / malformed value is refused with the parameter named', hostile.every((q) => { const r = P(q); return r.ok === false && typeof r.error.param === 'string' && r.error.title && r.error.message; }), hostile.filter((q) => P(q).ok).join(' '));
    t('boot: error text never echoes the offending value', hostile.every((q) => { const r = P(q); const val = decodeURIComponent((q.split('=')[1] || '')); return r.ok || val.length < 6 || !(r.error.message + r.error.title).includes(val); }));
    t('boot: a duplicated parameter uses the first value only', P('?cpu=easy&cpu=hard').params.cpu === 'easy');
    const fit = M.BO.fitScale;
    t('boot: fitScale picks whole device pixels', fit({ availW: 358, availH: 600, dpr: 3 }).k === 4 && fit({ availW: 358, availH: 600, dpr: 3 }).cssW === 320 / 1 && fit({ availW: 100, availH: 100, dpr: 1 }).k === 1 && fit({ availW: 960, availH: 640, dpr: 1 }).k === 4);
  }
  {
    const { TC, RM } = M;
    const R0 = await M.BO.resolveBattle(pack, { team: null, foe: 'random', seed: 5, format: '3v3', cpu: 'hard', quick: true });
    t('boot: Quick Battle resolves two random legal teams and a CPU seat', R0.ok && R0.spec.teams[0].length === 6 && R0.spec.teams[1].length === 6 && R0.spec.pick === 3 && R0.spec.sides[1].level === 'hard' && R0.spec.ruleset === 'arena-gen3-standard');
    const R1 = await M.BO.resolveBattle(pack, { team: null, foe: 'random', seed: 5, format: '3v3', cpu: 'hard', quick: true });
    t('boot: resolveBattle is deterministic in the seed', JSON.stringify(R0.spec.teams) === JSON.stringify(R1.spec.teams));
    // a real team code round trip
    const tm = M.MC.randomTeam(pack, 77, 4);
    const mons = tm.recs.map((r, i) => ({ species: r.species, nickname: '', level: r.level, nature: r.nature, abilitySlot: r.abilitySlot, heldItem: r.item, moves: r.moves, ev: r.evs, iv: r.ivs, gender: tm.meta[i].gender || '-', shiny: false, friendship: 255 }));
    const code = await TC.encodeTeamCode({ name: 'Test', ruleset: 'arena-gen3-standard', romSha256: RM.PINNED.sha256, mons });
    const R2 = await M.BO.resolveBattle(pack, { team: code, foe: 'random', seed: 9, format: '6v6', cpu: 'normal', quick: false });
    t('boot: a valid team code resolves to your four Pokemon', R2.ok && R2.spec.teams[0].length === 4 && R2.spec.teams[0][0].species === tm.recs[0].species && R2.spec.pick === 0, R2.ok ? '' : JSON.stringify(R2.error));
    const R3 = await M.BO.resolveBattle(pack, { team: code, foe: 'random', seed: 9, format: '3v3', cpu: 'normal', quick: false });
    t('boot: ... and a 4-Pokemon team can play 3v3', R3.ok && R3.spec.pick === 3);
    const small = await TC.encodeTeamCode({ name: 'Two', ruleset: 'arena-gen3-standard', romSha256: RM.PINNED.sha256, mons: mons.slice(0, 2) });
    const R4 = await M.BO.resolveBattle(pack, { team: small, foe: 'random', seed: 9, format: '3v3', cpu: 'normal', quick: false });
    t('boot: a 2-Pokemon team refuses 3v3 with an explanation', R4.ok === false && R4.error.param === 'format', JSON.stringify(R4.error || {}).slice(0, 100));
    const wrongRom = await TC.encodeTeamCode({ name: 'Other', ruleset: 'arena-gen3-standard', romSha256: 'f'.repeat(64), mons });
    const R5 = await M.BO.resolveBattle(pack, { team: wrongRom, foe: 'random', seed: 9, format: '6v6', cpu: 'normal', quick: false });
    t('boot: a team built for another ROM is refused', R5.ok === false && R5.error.param === 'team', R5.ok ? 'accepted' : R5.error.message.slice(0, 60));
    const illegalMons = mons.map((m, i) => (i === 0 ? { ...m, level: 7, moves: [{ id: 1, ppUps: 0 }, { id: 2, ppUps: 0 }, { id: 3, ppUps: 0 }, { id: 4, ppUps: 0 }, { id: 5, ppUps: 0 }].slice(0, 4), ev: { hp: 255, atk: 255, def: 255, spa: 0, spd: 0, spe: 0 } } : m));
    let illegal = null; try { illegal = await TC.encodeTeamCode({ name: 'Bad', ruleset: 'arena-gen3-standard', romSha256: RM.PINNED.sha256, mons: illegalMons }); } catch (_e) { illegal = null; }
    if (illegal) { const R6 = await M.BO.resolveBattle(pack, { team: illegal, foe: 'random', seed: 9, format: '6v6', cpu: 'normal', quick: false }); t('boot: an illegal team (EV total / moves) is refused with rules.js reasons', R6.ok === false && R6.error.param === 'team' && /break|rules|ruleset|total|EV/i.test(R6.error.message), R6.ok ? 'accepted' : R6.error.message.slice(0, 100)); }
    const R7 = await M.BO.resolveBattle(pack, { team: null, foe: 'ARENA1.xxxx.0000', seed: 9, format: '6v6', cpu: 'normal', quick: true });
    t('boot: an undecodable foe code is refused', R7.ok === false && R7.error.param === 'foe');
  }
  return f;
}

/* ======================================================================================================= run */

const t0 = Date.now();
const real = await loadStack(JS);
const manifestJson = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
if (UPDATE) {
  const man = real.BT.buildManifest(rom, real.RM.PINNED.sha256);
  fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 1) + '\n');
  console.log('rewrote text_manifest.json:', man.count, 'strings, notFound', man.notFound.length);
}
ok(crypto.createHash('sha256').update(rom).digest('hex') === real.RM.PINNED.sha256, '0. rom sha256 is the pinned v1.1.1 image');
ok(manifestJson.rom === real.RM.PINNED.sha256 && manifestJson.notFound.length === 0, '0. text_manifest.json is for the pinned ROM and lists nothing missing', JSON.stringify(manifestJson.notFound));
ok(Object.values(manifestJson.strings).every((e) => Object.keys(e).sort().join() === 'len,off,sha1' && Number.isInteger(e.off) && Number.isInteger(e.len) && /^[0-9a-f]{40}$/.test(e.sha1)), '0. text_manifest.json holds offsets, lengths and SHA-1s only (no string content)');

const realFails = await core(real, rom, {});
for (const x of realFails) ok(false, 'core: ' + x);
ok(realFails.length === 0, '1. every core check passes on the real tree (' + realFails.length + ' failing)');
if (core.strength) console.log('strength:', JSON.stringify(core.strength));

/* ---- goldens: frame hashes of fixed battles (HASHES ONLY) ---- */
{
  const pack = real.T.loadPack(rom, { verify: 'header', dexText: false });
  const ui = real.B.createBattleUi(rom);
  const text = real.BT.loadBattleText(rom, manifestJson);
  const frames = {};
  const A = real.MC.randomTeam(pack, 11001, 6), Bt = real.MC.randomTeam(pack, 11002, 6);
  const ctl = real.MC.createMatchController({ pack, teams: [A.recs, Bt.recs], seed: 4242, pick: 3, names: ['You', 'CPU Normal'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 9 }] });
  const scene = real.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 3, textSpeed: 'mid', meta: [A.meta, Bt.meta], trainer: 'CPU Normal', playerName: 'You' });
  ctl.start(); scene.begin(); scene.tick();
  const snap = (name) => { frames[name] = sha1(ui.render(scene.view()).rgba); };
  snap('preview');
  scene.press('a'); scene.press('down'); scene.press('a'); scene.press('down'); scene.press('a'); snap('preview.confirm');
  scene.press('a');
  for (let i = 1; i <= 12; i++) { for (let k = 0; k < 45; k++) scene.tick(); snap('intro.' + i); }
  let g = 0; while (scene.mode === 'steps' && g++ < 20000) scene.tick();
  snap('action'); scene.press('a'); snap('moves'); scene.press('a');
  for (let i = 1; i <= 16; i++) { for (let k = 0; k < 30; k++) scene.tick(); snap('turn1.' + i); }
  g = 0; while (scene.mode === 'steps' && g++ < 20000) scene.tick();
  snap('action2'); scene.press('down'); scene.press('a'); snap('party');
  frames.eventsHash = ctl.battle.logHash(); frames.stateHash = ctl.battle.hash();
  const sorted = JSON.stringify(frames, null, 1) + '\n';
  if (UPDATE) { fs.writeFileSync(GOLDEN, sorted); console.log('rewrote scene.golden.json (' + Object.keys(frames).length + ' hashes)'); }
  const gold = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const diff = Object.keys(frames).filter((k) => gold[k] !== frames[k]);
  ok(diff.length === 0 && Object.keys(gold).length === Object.keys(frames).length, '2. scene frame goldens match (' + Object.keys(frames).length + ' hashes)', diff.slice(0, 5).join(','));
  const tampered = { ...gold, action: 'deadbeef' };
  ok(Object.keys(frames).filter((k) => tampered[k] !== frames[k]).length === 1, '2. a tampered golden is detected');
  // a strip of PNGs for the eye
  const keys = ['preview', 'intro.3', 'intro.8', 'action', 'moves', 'turn1.4', 'turn1.9', 'party'];
  void keys;
}

/* ---- source mutants: the same core checks must fail on each ---- */
if (process.env.ARENA_SKIP_MUTANTS !== '1') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-scene-mut-'));
  const copyTree = (name) => { const d = path.join(tmp, name); fs.cpSync(JS, d, { recursive: true }); return d; };
  const mutants = [
    ['battle_text.js', 'sha1: rotate by 4', (s) => s.replace('rotl(a, 5)', 'rotl(a, 4)')],
    ['battle_text.js', "role: {f} is no longer the subject", (s) => s.replace("'f': 'subj'", "'f': 'other'")],
    ['battle_text.js', 'catalog: super effective typo', (s) => s.replace("'super': \"It's super effective!\"", "'super': \"It's super effective?\"")],
    ['battle_text.js', 'finder skips the boundary check', (s) => s.replace("if (rom[i + n.length] !== 0xff) continue;", 'if (false) continue;').replace("if (i > lo && rom[i - 1] !== 0xff && rom[i - 1] !== 0x00) continue;", 'if (false) continue;')],
    ['battle_text.js', 'manifest hash check disabled', (s) => s.replace("(o.trustOffsets || sha1Hex(rom.subarray(m.off, m.off + m.len)) === m.sha1)", 'true')],
    ['ai.js', 'ai picks the WORST move (normal)', (s) => s.replace("  const best = pickBest(rng, scored, 0.1);", "  const best = scored.slice().sort((a, b) => a.v - b.v)[0];").replace("if (rng(100) < SLIP_PERCENT)", 'if (false)')],
    ['ai.js', 'ai peeks: reads the foe\'s hidden moves from the view', (s) => s.replace("revealedMoves: (f.revealed && f.revealed.mv) ? f.revealed.mv.slice() : [],", "revealedMoves: (f.mv ? f.mv.map((x) => x.id) : []), peek: f.stats && f.stats.atk,")],
    ['ai.js', 'hard slips like normal (30% random moves)', (s) => s.replace("const best = attacks.reduce((a, b) => (b.v > a.v ? b : a));      // exact ties keep the lower slot: no randomness at all", "const best = rng(100) < 30 ? attacks[rng(attacks.length)] : attacks.reduce((a, b) => (b.v > a.v ? b : a));")],
    ['ai.js', 'ai may choose a disabled move', (s) => s.replace("function legalMoves(request) { return (request.moves || []).filter((m) => !m.disabled); }", "function legalMoves(request) { return (request.moves || []); }")],
    ['scene.js', 'drain stops at the old HP', (s) => s.replace("q({ t: 'drain', side: e.s, to: e.to, max: e.max });\n    const r = roles(e.s), src = e.src;", "q({ t: 'drain', side: e.s, to: e.from, max: e.max });\n    const r = roles(e.s), src = e.src;").replace("    const drain = () => q({ t: 'drain', side: e.s, to: e.to, max: e.max });", "    const drain = () => q({ t: 'drain', side: e.s, to: e.from, max: e.max });")],
    ['scene.js', 'the foe no longer leads', (s) => s.replace("if (i0 >= 0 && i1 >= 0 && i0 < i1 && !S.P[viewSide].shown && !S.P[foeSide].shown) { const t = out[i0]; out[i0] = out[i1]; out[i1] = t; }", '')],
    ['scene.js', 'action cells swapped', (s) => s.replace("for (let i = 0; i < 4; i++) if (inRect(c[i], x, y)) return { kind: 'action', index: i }; return null; }", "for (let i = 0; i < 4; i++) if (inRect(c[i], x, y)) return { kind: 'action', index: i ^ 1 }; return null; }")],
    ['scene.js', 'pause-menu FORFEIT forfeits instantly (no confirm)', (s) => s.replace("else if (label === 'FORFEIT') { S.menu = null; S.overlay = null; S.mode = back; openConfirm('forfeit', back); }", "else if (label === 'FORFEIT') { S.menu = null; S.overlay = null; S.mode = 'steps'; submit({ kind: 'forfeit' }); }")],
    ['scene.js', 'FA1: the move menu box loses its type name ("TYPE/Normal" would read "TYPE/")', (s) => s.replace('type: r.type, typeName: typeName(r.type) })), tick: S.tick }; }', "type: r.type, typeName: 'x' })), tick: S.tick }; }")],
    ['scene.js', 'W1 D1: the result screen takes a choice at once (no guard)', (s) => s.replace('if (!resultArmed()) return; ', 'if (false) return; ')],
    ['scene.js', 'W1 D3: the leave confirm at the preview loses the preview behind it', (s) => s.replace("((S.confirm.kind === 'forfeit' || S.confirm.kind === 'quit') && S.confirm.back === 'preview')", "(S.confirm.kind === 'forfeit' && S.confirm.back === 'preview')")],
    ['battle_resume.js', 'W1 D11: a replay that does not match the saved hash is accepted', (s) => s.replace("if (!why && String(ctl.battle.hash()) !== String(rec.hash)) why = 'the replayed battle is not the saved one';", '')],
    ['battle_resume.js', 'W1 D11: a fresh visit of the address resumes the old battle', (s) => s.replace("if (info.navType !== 'reload' && info.navType !== 'back_forward') {", 'if (false) {')],
    ['battle_resume.js', 'W1 D11: a refused choice in the record is shrugged off', (s) => s.replace("if (!r || !r.ok) why = ", 'if (false) why = ')],
    ['battle_resume.js', 'W1 D11: a finished battle still writes its record', (s) => s.replace('try { if (ctl.winner !== null) store.clear(); else store.write(snapshotOf(ctl, seed, humanSide)); }', 'try { store.write(snapshotOf(ctl, seed, humanSide)); }')],
    ['scene.js', 'W1 D11: catchUp plays nothing', (s) => s.replace("while (n < max && (S.mode === 'steps' || S.cur || S.queue.length)) { tick(); n++; } } finally", 'while (n < 0) { tick(); n++; } } finally')],
    ['scene.js', 'W1 D11: catchUp leaves A held down', (s) => s.replace('finally { S.held.a = a; S.held.b = b; }', 'finally { }')],
    ['scene.js', 'W1 A4: a tap above the move menu does nothing', (s) => s.replace("return y < ui.R.mv[0].y ? { kind: 'back', index: 0 } : null;", 'return null;')],
    ['scene.js', 'W1 A4: a tap beside an open menu does nothing', (s) => s.replace("return { kind: 'back', index: 0 };          // W1 fix A4: a tap beside an open menu", 'return null;          // W1 fix A4: a tap beside an open menu')],
    ['scene.js', 'W1 A5: the INFO target is not acted on', (s) => s.replace("case 'info': press('x'); break;", "case 'info': break;")],
    ['scene.js', 'W1 A4: a BACK target is not acted on', (s) => s.replace("case 'back': press('b'); break;", "case 'back': break;")],
    ['battle_ui.js', 'W1 A4: ui.hitTest does not know the BACK target above the move menu', (s) => s.replace("return y < R.mv[0].y ? { kind: 'back', index: 0 } : null; }", 'return null; }')],
    ['scene.js', 'forfeit confirm defaults to YES',(s) => s.replace("S.confirm = { kind, cursor: 1, back: back || 'action' };", "S.confirm = { kind, cursor: 0, back: back || 'action' };")],
    ['matchctl.js', 'submit does not pump (CPU never answers)', (s) => s.replace("    pump();\n    return r;\n  }\n  const remoteSide", "    return r;\n  }\n  const remoteSide")],
    ['battle_boot.js', 'URL code pattern accepts anything', (s) => s.replace("const CODE_RE = /^ARENA1\\.[A-Za-z0-9_-]{1,1000}\\.[0-9a-fA-F]{4}$/;", 'const CODE_RE = /.*/;')],
    ['battle_boot.js', 'seed range unchecked', (s) => s.replace("|| Number(seedS) > 4294967295", '')],
    ['battle_boot.js', 'fitScale rounds up', (s) => s.replace('Math.floor(Math.min((availW * d) / SCREEN_W, (availH * d) / SCREEN_H) + 1e-9)', 'Math.ceil(Math.min((availW * d) / SCREEN_W, (availH * d) / SCREEN_H))')],
  ];
  const twinDir = copyTree('twin');
  const twin = await loadStack(twinDir, '?twin');
  const twinFails = await core(twin, rom, { fast: true });
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
    try { const M = await loadStack(dir, '?m' + mi); fails = await core(M, rom, { fast: true }); } catch (e) { fails = ['threw: ' + String(e.message).slice(0, 80)]; }
    const dead = fails.length > 0;
    if (dead) killed++;
    ok(dead, '3. mutant killed: ' + file + ' / ' + name, dead ? fails[0].slice(0, 70) : 'survived');
  }
  console.log('mutants killed ' + killed + ' of ' + mutants.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s); ' + nChecks + ' individual checks ran inside the core runs (real tree + twin + mutants)');
if (fail) { console.log(failures.join('\n')); process.exit(1); }
