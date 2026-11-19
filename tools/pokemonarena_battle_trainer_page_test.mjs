#!/usr/bin/env node
// POKEMONARENA BATTLE TRAINER PAGE TEST -- battle.html shows the TRAINER of the profile that fights (INAPP.md TRAINER decision 3, "BATTLE: as built" there), in real headless Chrome with the
// real IndexedDB: the name in the battle and on its result screen, the back figure handed to the ROM's runs. The Node half (the choices, the ROM drawing every back figure pixel-exact, the name
// fitting every window) is tools/pokemonarena_battle_trainer_test.mjs; the online opponent's figure is tools/pokemonarena_netmatch_test.mjs case T and the online page test.
//
//   node tools/pokemonarena_battle_trainer_page_test.mjs [--mutants]      ARENA_PORT (default 8261) ARENA_CDP (default 9461) ARENA_OUT=<dir for screenshots>
//
//   P1  no profile                    'You', no back figure (the ROM's default), the result row says YOU
//   P2  a schema-6 trainer            its name and its card's back figure reach the scene (scene.trainerInfo()), the result row says the name
//   P3  a card with no back figure    the name, and the ROM's default figure (nothing handed over)
//   P4  a team battle                 the trainer is the one that OWNS the team in the address, not the active one (the career's own lookup, battle_boot.js fighterId)
//   --mutants: three defects of battle_boot.js served through tools/pokemonarena_overlay.mjs, each must trip its named case.
// Browsers: tools/headless_cdp.mjs only (muted, throwaway profile), one at a time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ARENA_PORT = process.env.ARENA_PORT || '8261';
process.env.ARENA_CDP = process.env.ARENA_CDP || '9461';
const L = await import('./pokemonarena_hub_lib.mjs');
const { withBrowser } = await import('./headless_cdp.mjs');
const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
const { root, BASE, J, addInit, AUDIO_DOUBLE } = L;
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-battle-trainer-shots');
fs.mkdirSync(OUT, { recursive: true });
const C = L.makeCounter('battle-trainer-page');
const B = '(window.__arenaBattle)';
const ev = (page, e) => page.eval(e);
const WANT_MUTANTS = process.argv.includes('--mutants');

/* ---- in-page: the real store ---- */
const CLEAR = `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); try { for (const row of await store.listProfiles()) await store.deleteProfile(row.id); } finally { await store.close(); } return true; })()`;
const MAKE = (name, card) => `(async () => { const S = await import('/pokemonarena/js/store.js'), T = await import('/pokemonarena/js/trainer_store.js'); const store = await S.openStore(); try { const r = await T.createTrainer(store, { name: ${J(name)}, card: ${J(card)} }); return r.ok ? r.id : 'refused: ' + r.code; } finally { await store.close(); } })()`;
// a trainer that owns one legal team (built the way the hub's tests seed one), NOT made the active one; -> its team code
const MAKE_WITH_TEAM = (name, card) => `(async () => {
  const S = await import('/pokemonarena/js/store.js'), P = await import('/pokemonarena/js/profile.js'), R = await import('/pokemonarena/js/rules.js'), TB = await import('/pokemonarena/js/tables.js'), RF = await import('/pokemonarena/js/romfetch.js'), D = await import('/pokemonarena/js/hub_data.js');
  const { bytes } = await RF.loadVerifiedRom();
  const pack = TB.loadPack(bytes, { verify: 'header', dexText: false });
  const store = await S.openStore();
  try {
    const active = await store.getActiveId();
    const mk = (n) => { const sid = pack.species.findIndex((s) => s && s.legal && s.name === n); const rec = R.blankRec(sid, pack, R.DEFAULT_RULESET_ID); const ratio = pack.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M' }); };
    const created = await store.createProfile({ trainerName: ${J(name)}, card: ${J(card)} });
    const mons = ['Pikachu', 'Charizard', 'Blastoise'].map(mk), team = P.createTeam({ name: 'Mine', monIds: mons.map((m) => m.id) });
    const saved = await store.saveProfile({ ...created, box: mons, teams: [team] }, { reason: 'seed' });
    if (active) await store.setActiveId(active);
    const code = await D.teamCodeFor(store, saved.id, team.id);
    return code.ok ? code.code : 'no code: ' + code.message;
  } finally { await store.close(); }
})()`;
const openBattle = async (page, query) => {
  const q = query + (query.includes('?') ? '&' : '?') + 'style=set';
  await page.navigate(BASE + '/pokemonarena/battle.html' + q);
  await page.waitFor(`${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
  const st = await ev(page, `${B}.state`);
  if (st === 'ready') await ev(page, `window.__arenaNavigate = () => {}; true`);
  return st;
};
const info = (page) => ev(page, `(() => { const i = ${B}.scene.trainerInfo(); return { hook: ${B}.trainer, name: i.playerName, back: i.playerBack === undefined ? 'none' : i.playerBack }; })()`);
const finish = async (page) => { await ev(page, `${B}.autoplay(600000)`); await page.waitFor(`${B}.mode === 'result'`, { timeoutMs: 30000 }); return ev(page, `${B}.scene.view().result.mineLabel`); };

/** The cases. only: a set of case ids (a mutant run plays only the case that names it). -> nothing; reports through ok() with the tag. */
async function cases(page, tag, only) {
  const run = (id) => !only || only.includes(id);
  const ok = (c, name, d) => C.ok(c, tag + name, d);
  await page.navigate(BASE + '/pokemonarena/battle.html?seed=1&format=3v3&cpu=easy&style=set');
  await page.waitFor(`${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
  await ev(page, CLEAR);
  if (run('P1')) {
    ok((await openBattle(page, '?seed=5&format=3v3&cpu=easy')) === 'ready', 'P1 the battle page is ready with no profile');
    const i = await info(page);
    ok(i.hook && i.hook.name === 'You' && i.hook.back === null && i.name === 'You' && i.back === 'none', 'P1 no profile: the player is "You" and no back figure is handed to the ROM', J(i));
    ok((await finish(page)) === 'YOU', 'P1 ... and the result row says YOU');
  }
  if (run('P2') || run('P3')) {
    const id = await ev(page, MAKE('Casey', { made: true, back: 5, front: 12 }));
    ok(typeof id === 'string' && !/^refused/.test(id), 'P2 a schema-6 trainer is made in the real store (trainer_store.js createTrainer)', String(id));
    ok((await openBattle(page, '?seed=6&format=3v3&cpu=easy')) === 'ready', 'P2 the battle page is ready');
    const i = await info(page);
    ok(i.hook && i.hook.name === 'Casey' && i.hook.back === 5 && i.name === 'Casey' && i.back === 5, 'P2 the trainer\'s name and back figure 5 reach the scene', J(i));
    await page.screenshot(path.join(OUT, 'p2-casey.png'));
    ok((await finish(page)) === 'CASEY', 'P2 ... and the result row says CASEY');
    if (run('P3')) {
      await ev(page, CLEAR);
      await ev(page, MAKE('Lyra', { made: true, back: null }));
      await openBattle(page, '?seed=7&format=3v3&cpu=easy');
      const j = await info(page);
      ok(j.hook && j.hook.name === 'Lyra' && j.hook.back === null && j.name === 'Lyra' && j.back === 'none', 'P3 a card with no back figure: the name, and nothing handed over (the ROM\'s default)', J(j));
    }
  }
  if (run('P4')) {
    await ev(page, CLEAR);
    await ev(page, MAKE('Active', { made: true, back: 2 }));
    const code = await ev(page, MAKE_WITH_TEAM('Owner', { made: true, back: 6, front: null, look: null, partner: null }));
    ok(typeof code === 'string' && code.startsWith('ARENA1.'), 'P4 a second trainer owns a team (and is not the active one)', String(code).slice(0, 60));
    ok((await openBattle(page, '?team=' + encodeURIComponent(code) + '&foe=random&seed=8&format=3v3&cpu=easy')) === 'ready', 'P4 the team battle is ready');
    const i = await info(page);
    ok(i.hook && i.hook.name === 'Owner' && i.back === 6, 'P4 a team battle shows the trainer who OWNS the team (name and back figure), not the active one', J(i));
  }
  const errs = L.errsOf(page).filter((e) => !/favicon/i.test(e));
  ok(errs.length === 0, 'page errors: none', errs.slice(0, 3).join(' | '));
}

async function session(name, port, fn) {
  console.log('--- ' + name + ' ' + L.loadPct());
  try {
    await withBrowser({ port, width: 1280, height: 800 }, async (page) => { await page.setViewport(1280, 800, { mobile: false, dpr: 1 }); await addInit(page, AUDIO_DOUBLE); await fn(page); });
  } catch (e) { C.ok(false, name + ': session threw', String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
}

const MUTANTS = [
  ['the page always says You', "playerName: shown.name, ...(shown.back !== null ? { playerBack: shown.back } : {}), trainerChoices:", "playerName: 'You', ...(shown.back !== null ? { playerBack: shown.back } : {}), trainerChoices:", ['P2']],
  ['the back figure is never handed to the scene', "playerName: shown.name, ...(shown.back !== null ? { playerBack: shown.back } : {}), trainerChoices:", 'playerName: shown.name, trainerChoices:', ['P2']],
  ['the trainer is always the active profile (a team battle shows the wrong one)', 'const id = pid || await fighterId(store, data, null);', 'const id = pid || await store.getActiveId();', ['P4']],
];

let server = null;
try {
  console.log('before the browser: ' + L.loadPct());
  server = await L.startServer('/pokemonarena/battle.html');
  console.log('dev server up on ' + BASE);
  const CDP = Number(process.env.ARENA_CDP);
  await session('desktop', CDP, (page) => cases(page, 'desktop: ', null));
  if (WANT_MUTANTS) {
    const PORT = Number(process.env.ARENA_PORT);
    for (let i = 0; i < MUTANTS.length; i++) {
      const [name, from, to, only] = MUTANTS[i];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-trainer-page-mut-'));
      let ov = null;
      try {
        copyTree(path.join(root, 'pokemonarena'), path.join(dir, 'pokemonarena'));
        mutateFile(path.join(dir, 'pokemonarena'), 'js/battle_boot.js', from, to);
        ov = await startOverlay({ dir, port: PORT + 1 + i, upstream: BASE });
        const before = C.fail;
        const saveBase = process.env.ARENA_BASE;
        await session('mutant: ' + name, CDP + 1 + i, async (page) => {
          const real = page.navigate.bind(page);
          page.navigate = (u) => real(String(u).replace(BASE, 'http://127.0.0.1:' + (PORT + 1 + i)));
          await cases(page, 'MUTANT ' + name + ': ', only);
        });
        const failedHere = C.fail - before;
        C.fail -= failedHere; C.failures.splice(C.failures.length - failedHere, failedHere);          // (the mutant's failures are its death, not the suite's)
        C.ok(failedHere > 0, 'mutant killed: ' + name + ' (' + only.join(',') + ')', failedHere ? '' : 'survived');
        if (saveBase !== undefined) process.env.ARENA_BASE = saveBase;
      } catch (e) { C.ok(false, 'mutant ' + name + ' could not run', String(e && e.message ? e.message : e)); }
      finally { if (ov) ov.stop(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
    }
  }
} finally { L.stopServer(server); }
C.finish();
