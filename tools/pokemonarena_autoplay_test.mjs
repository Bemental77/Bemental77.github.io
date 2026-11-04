#!/usr/bin/env node
// tools/pokemonarena_autoplay_test.mjs -- WHEN MAY THE ARENA'S MUSIC START, MEASURED IN A REAL BROWSER, and does the page use what the browser allows?
//
//   node tools/pokemonarena_autoplay_test.mjs                 the experiment + the page
//   node tools/pokemonarena_autoplay_test.mjs --mutants       ALSO break the page four ways on an overlay copy; each must fail a case
//   ARENA_PORT=8777 ARENA_CDP=9763 ARENA_OVERLAY_PORT=8790 ARENA_OUT=<dir>      (ARENA_BASE=<url> tests an already running server)
//   ARENA_AUTOPLAY_EXPECT='{"hubFresh":"allowed",...}'          TEST SEAM: pretend the browser was expected to behave differently (the skip self-test below uses it)
//
// THIS IS THE ONE PLACE A REAL AudioContext IS READ. The browser runs with --mute-audio (tools/headless_cdp.mjs: nothing reaches a speaker) and WITHOUT --autoplay-policy=no-user-gesture-required
// (withBrowser({ autoplay: false })), so it has the policy a real visitor's Chrome has. Every other test replaces AudioContext with a recording double (pokemonarena_sound_lib.mjs), which can emulate the
// same policy. The music engine is the stand-in (window.__arenaSoundModules): this test asks when the CONTEXT may run and when the page asks for a song, not what the engine renders.
//
// THE EXPERIMENT (page code not involved): does Chrome carry a user gesture across a SAME-ORIGIN navigation, and may Web Audio start in the new document?
//   1 hub, no gesture            navigator.userActivation.hasBeenActive false; a new AudioContext is 'suspended'; resume() stays pending
//   2 a real CDP click on a same-origin link, which loads battle.html:  hasBeenActive TRUE; a new AudioContext is 'running' at once
//   3 a real click whose handler calls location.assign (what the hub does on Start): the same
//   4 the same address typed (no gesture): suspended again (the control: the difference is the carried gesture, not the page)
// MEASURED 2026-11-03 on Chrome/156.0.8078.79 (Windows, headless=new, muted): 1 blocked, 2 and 3 allowed, 4 blocked. MUSIC.md records it. Another build, another engine (Safari, Firefox) or another policy may
// differ. THE TABLE IS NOT AN ASSERTION ON A BROWSER THAT DIFFERS: what holds in every browser is asserted (a document nobody has touched has no user activation), the four verdicts are printed either
// way, and when they do not reproduce the table above this test SKIPS the table-specific cases and every page case with a clear "SKIP:" message and exits 0, because the page cases are only meaningful
// on the policy they were written against. The skip is itself tested (the "skip self-test" at the end re-runs this file against a table it cannot match and requires exit 0, a SKIP line and no FAIL).
//
// THE PAGE (when the experiment reproduces): the page TRIES to start the sound at load (the mixer's earlyStart), so
//   a  a visitor who arrived by a click on the site gets a RUNNING context on the battle page without another click, and the battle song is asked for before any input
//   b  a visitor with no gesture yet gets a SUSPENDED context and the hint, and the first key / click / touch ANYWHERE on the page starts it, with no Sound button
//   c  the battle starts on the CLASSIC battle song (the CPU level's own: easy = the wild theme, normal = the trainer theme), never the team-preview song
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.ARENA_PORT = process.env.ARENA_PORT || '8777';
process.env.ARENA_CDP = process.env.ARENA_CDP || '9763';
const L = await import('./pokemonarena_hub_lib.mjs');
const { withBrowser } = await import('./headless_cdp.mjs');
const { STUB_MODULES_SRC } = await import('./pokemonarena_sound_lib.mjs');
const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
const { root, BASE, sleep, J, addInit } = L;
const WANT_MUTANTS = process.argv.includes('--mutants');
const PA = path.join(root, 'pokemonarena');
const C = L.makeCounter('autoplay');
let cdp = L.CDP0;
const MEASURED = { hubFresh: 'blocked', afterLink: 'allowed', afterAssign: 'allowed', typed: 'blocked' };       // the table measured on Chrome 156.0.8078.79
const EXPECT = (() => { try { return process.env.ARENA_AUTOPLAY_EXPECT ? JSON.parse(process.env.ARENA_AUTOPLAY_EXPECT) : MEASURED; } catch (_e) { return MEASURED; } })();

const PROBE = `(async () => {
  const ua = navigator.userActivation ? { has: navigator.userActivation.hasBeenActive, now: navigator.userActivation.isActive } : null;
  const c = new AudioContext(); const created = c.state;
  let r; try { r = await Promise.race([c.resume().then(() => 'resolved'), new Promise((res) => setTimeout(() => res('pending'), 600))]); } catch (e) { r = 'rejected:' + e.name; }
  const after = c.state; try { c.close(); } catch (e) {}
  return { ua, created, after, resume: r };
})()`;
const verdict = (p) => (p.after === 'running' ? 'allowed' : 'blocked');
const sound = (page) => page.eval(`window.__arenaSound ? window.__arenaSound.state() : null`);
const wants = (page) => page.eval(`window.__arenaSound.state().director.log.filter((x) => x.op === 'want').map((x) => x.key)`);
const plays = (page) => page.eval(`window.__sndMusic && window.__sndMusic.play ? window.__sndMusic.play.map((p) => p.index) : []`);
// 3v3: the battle OPENS on a team preview, which used to play the encounter song; the classic start must already be the battle song there
const BAT = '/pokemonarena/battle.html?cpu=normal&seed=5&format=3v3';
const batReady = (page) => page.waitFor(`window.__arenaBattle && __arenaBattle.state === 'ready' && window.__arenaSound`, { timeoutMs: 60000 });
const hubReady = (page) => page.waitFor(`window.__arenaHub && __arenaHub.state === 'ready' && window.__arenaSound`, { timeoutMs: 60000 });

async function experiment(page, base, R) {
  await page.navigate(base + '/pokemonarena/manifest.json'); await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}');
  await page.navigate(base + '/pokemonarena/'); await hubReady(page); await sleep(400);
  const m = {};
  m.hubFresh = await page.eval(PROBE);
  const c = await L.elementCentre(page, '#playFriend'); await page.click(c.x, c.y);
  await page.waitFor('location.pathname.endsWith("battle.html")', { timeoutMs: 30000 }); await sleep(1200);
  m.afterLink = await page.eval(PROBE);
  await page.navigate(base + '/pokemonarena/'); await hubReady(page); await sleep(400);
  await page.eval(`document.addEventListener('pointerup', () => { location.assign('${BAT}'); }, { once: true })`);
  await page.click(600, 420);
  await page.waitFor('location.pathname.endsWith("battle.html")', { timeoutMs: 30000 }); await sleep(1200);
  m.afterAssign = await page.eval(PROBE);
  await page.navigate(base + BAT); await sleep(1200);
  m.typed = await page.eval(PROBE);
  const got = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, verdict(v)]));
  const same = J(got) === J(EXPECT);
  console.log('measured: ' + J(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { sticky: v.ua && v.ua.has, new: v.created, afterResume: v.after, resume: v.resume }]))));
  // true in EVERY browser: a document nobody has clicked, tapped or typed in has no user activation (where the browser reports it at all)
  R.ok((!m.hubFresh.ua || m.hubFresh.ua.has === false) && (!m.typed.ua || m.typed.ua.has === false), 'experiment: a freshly loaded document nobody has touched has no user activation (the hub, and the battle address typed)', J({ hub: m.hubFresh.ua, typed: m.typed.ua }));
  // the table of THIS browser family: asserted only where it reproduces (otherwise the run says SKIP below; these two were never written for another browser's policy)
  if (same) {
    R.ok(m.hubFresh.ua && m.hubFresh.ua.has === false && got.hubFresh === 'blocked' && m.typed.ua.has === false && got.typed === 'blocked', 'experiment: with no gesture the default policy keeps a new AudioContext suspended (the hub, and the battle address typed): this is a real browser policy, not a test setting', J(got));
    R.ok(got.afterLink === 'allowed' && m.afterLink.ua.has === true && got.afterAssign === 'allowed' && m.afterAssign.ua.has === true, 'experiment: after a real click on the previous page, a same-origin navigation (a link, and the hub\'s click-then-location.assign) leaves the NEW document with sticky user activation, and its AudioContext may run at once', J(got));
  }
  return { same, got };
}

async function pageCases(page, base, R, tag = '') {
  await page.navigate(base + '/pokemonarena/manifest.json'); await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}');
  // (a) arrive by a real click: the battle page needs no second click
  await page.navigate(base + '/pokemonarena/'); await hubReady(page); await sleep(300);
  const h0 = await sound(page);
  R.ok(h0.mixer.created === true && h0.mixer.ctx === 'suspended' && h0.prompt === true, tag + 'hub, no gesture yet: the page already TRIED (a context exists) and the browser refused (it is suspended), so the hint is up', J({ created: h0.mixer.created, ctx: h0.mixer.ctx, prompt: h0.prompt }));
  await page.eval(`document.addEventListener('pointerup', () => { location.assign('${BAT}'); }, { once: true })`);
  await page.click(600, 420);
  await page.waitFor('location.pathname.endsWith("battle.html")', { timeoutMs: 30000 });
  await batReady(page);
  await page.waitFor(`window.__arenaSound.state().mixer.ctx === 'running'`, { timeoutMs: 8000 }).catch(() => {});
  const b0 = await sound(page);
  R.ok(b0.mixer.ctx === 'running' && b0.prompt === false, tag + 'battle page after a click on the hub: the AudioContext is RUNNING with no input at all in this document, and the "start the sound" hint is not shown', J({ ctx: b0.mixer.ctx, prompt: b0.prompt }));
  const w = await wants(page);
  R.ok(w.length > 0 && w[0] === 'battle_normal' && !w.includes('preview'), tag + 'battle page: the first song asked for is the CPU level\'s battle song (battle_normal), never the team-preview song, before any input', J(w));
  await page.waitFor(`window.__sndMusic && window.__sndMusic.play.length > 0`, { timeoutMs: 8000 }).catch(() => {});
  R.ok((await plays(page)).length > 0 && (await plays(page))[0] === 21, tag + 'battle page: the engine is told to PLAY that song (stand-in index 21) without a second click', J(await plays(page)));
  // (b) no gesture at all (the address typed): suspended + hint, then the first key anywhere starts it
  await page.navigate(base + BAT); await batReady(page); await sleep(500);
  const t0 = await sound(page);
  R.ok(t0.mixer.created === true && t0.mixer.ctx === 'suspended' && t0.prompt === true, tag + 'battle page, address typed (no gesture anywhere): a context exists but is suspended, and the hint is up', J({ created: t0.mixer.created, ctx: t0.mixer.ctx, prompt: t0.prompt }));
  R.ok((await plays(page)).length === 0, tag + 'battle page, no gesture: nothing is played yet (the engine is not asked while the browser refuses)', J(await plays(page)));
  // A bare modifier key (Shift) and Escape are NOT user activations in Chrome (MUSIC.md): a real Shift press and a real Escape press leave the context suspended and the document without sticky activation.
  // (The page tries unlock() on both anyway, the mixer's listeners are armed for keydown; the BROWSER is what refuses.) A letter key is one, below.
  for (const [k, code, vk] of [['Shift', 'ShiftLeft', 16], ['Escape', 'Escape', 27]]) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await sleep(60); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); await sleep(300);
    const t = await sound(page); const act = await page.eval('navigator.userActivation ? navigator.userActivation.hasBeenActive : null');
    R.ok(t.mixer.ctx === 'suspended' && act === false, tag + 'battle page: a real ' + k + ' key press is not a user activation: the context stays suspended and the document has no sticky activation', J({ ctx: t.mixer.ctx, hasBeenActive: act }));
  }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' }); await sleep(40); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await page.waitFor(`window.__arenaSound.state().mixer.ctx === 'running'`, { timeoutMs: 5000 }).catch(() => {});
  const t1 = await sound(page);
  R.ok(t1.mixer.ctx === 'running' && t1.prompt === false, tag + 'battle page: the first key press ANYWHERE (not on any button) starts the context and hides the hint', J({ ctx: t1.mixer.ctx, prompt: t1.prompt }));
  await page.waitFor(`window.__sndMusic.play.length > 0`, { timeoutMs: 8000 }).catch(() => {});
  R.ok((await plays(page))[0] === 21, tag + 'battle page: and the battle song then plays (stand-in index 21)', J(await plays(page)));
  // (c) a first click anywhere does the same on the hub
  await page.navigate(base + '/pokemonarena/'); await hubReady(page); await sleep(300);
  R.ok((await sound(page)).mixer.ctx === 'suspended', tag + 'hub, typed address: suspended', '');
  await page.click(30, 770);
  await page.waitFor(`window.__arenaSound.state().mixer.ctx === 'running'`, { timeoutMs: 5000 }).catch(() => {});
  R.ok((await sound(page)).mixer.ctx === 'running' && (await sound(page)).prompt === false, tag + 'hub: the first click on empty page area starts the context (the Sound button is not needed)', J(await sound(page).then((s) => s.mixer.ctx)));
  await page.waitFor(`window.__sndMusic.play.length > 0`, { timeoutMs: 8000 }).catch(() => {});
  R.ok((await plays(page))[0] === 10, tag + 'hub: the hub song starts on that click (stand-in index 10)', J(await plays(page)));
  // (d) a muted visitor stays muted and nothing runs (a stored choice wins)
  await page.eval(`localStorage.setItem('arena.audio', JSON.stringify({ v: 1, master: 0.5, music: 0.6, fx: 0.8, muted: true, soundtrack: 'soulgold' }))`);
  await page.navigate(base + '/pokemonarena/'); await hubReady(page); await sleep(300);
  const m0 = await sound(page);
  R.ok(m0.mixer.created === false && m0.mixer.settings.muted === true && m0.prompt === false, tag + 'a visitor who muted the sound keeps it: no context is created at load, no hint, nothing plays', J({ created: m0.mixer.created, muted: m0.mixer.settings.muted, prompt: m0.prompt }));
  await page.eval(`localStorage.removeItem('arena.audio')`);
  // (e) the starting volume
  await page.navigate(base + '/pokemonarena/'); await hubReady(page); await sleep(300);
  R.ok((await sound(page)).mixer.settings.master === 0.5 && (await page.eval(`document.getElementById('abVolume').value`)) === '50', tag + 'nothing stored: Master starts at 50% and the visible slider reads 50', J((await sound(page)).mixer.settings));
}

const MUTANTS = [
  { id: 'A1 the page does not try at load (the mixer\'s early start is off)', file: 'js/sound_system.js', from: 'createMixer({ window: win, document: doc, storage: opts.storage, earlyStart: true,', to: 'createMixer({ window: win, document: doc, storage: opts.storage, earlyStart: false,' },
  { id: 'A2 the team preview plays the encounter song again', file: 'js/sound_system.js', from: "if (want === 'preview') director.battle(cpu);", to: "if (want === 'preview') director.set('preview');" },
  { id: 'A3 a muted visitor gets a context at load', file: 'js/audio_mixer.js', from: 'if (earlyStart && !S.settings.muted && !S.hidden', to: 'if (earlyStart && !S.hidden' },
  { id: 'A4 the starting volume is 70% again', file: 'js/audio_mixer.js', from: 'v: 1, master: 0.5, music: 0.6, fx: 0.8, muted: false, soundtrack: \'soulgold\' });      //', to: 'v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: false, soundtrack: \'soulgold\' });      //' },
];

const server = await L.startServer();
try {
  let verdictSame = false;
  await withBrowser({ port: cdp, width: 1280, height: 800, autoplay: false, lock: false }, async (page) => {
    const v = await (await fetch('http://127.0.0.1:' + cdp + '/json/version')).json();
    console.log('browser: ' + v.Browser + ' (autoplay flag omitted: the default policy), muted');
    await addInit(page, STUB_MODULES_SRC);
    const R = { ok: (c, n, d) => C.ok(c, n, d) };
    const e = await experiment(page, BASE, R);
    verdictSame = e.same;
    if (!e.same) {
      console.log('SKIP: this browser (' + v.Browser + ') does not reproduce the table the page cases were written against (' + J(EXPECT) + '); it measured ' + J(e.got) + '. The browser-independent experiment case above still ran; the table-specific cases and every page case depend on the table and are skipped, not failed (exit 0).');
      return;
    }
    await pageCases(page, BASE, R);
  });
  cdp += 4;
  // SKIP SELF-TEST. "A different browser SKIPS, it does not fail" is a promise of this file, so it is run: the same file is started again with a table it cannot match (the measured one with every verdict
  // flipped, through the ARENA_AUTOPLAY_EXPECT seam), and that run must print SKIP, exit 0, print no FAIL line, and have run ONLY the browser-independent case (1 passed): none of the page cases.
  if (!process.env.ARENA_AUTOPLAY_CHILD && !process.argv.includes('--no-selftest') && verdictSame) {
    const flipped = Object.fromEntries(Object.entries(MEASURED).map(([k, v]) => [k, v === 'blocked' ? 'allowed' : 'blocked']));
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ARENA_AUTOPLAY_CHILD: '1', ARENA_AUTOPLAY_EXPECT: JSON.stringify(flipped), ARENA_PORT: String(Number(process.env.ARENA_PORT) + 1), ARENA_CDP: String(cdp + 8) }, encoding: 'utf8', timeout: 400000, maxBuffer: 16 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    C.ok(r.status === 0 && /^SKIP: /m.test(out) && !/^FAIL/m.test(out) && /OK: 1 passed, 0 failed/.test(out), 'skip self-test: against a table this browser cannot match the run prints SKIP, exits 0, prints no FAIL line and runs no page case', 'exit ' + r.status + ' | ' + out.split('\n').filter((l) => /SKIP|FAIL|OK:|passed/.test(l)).join(' | ').slice(0, 500));
    cdp += 16;
  }
  if (WANT_MUTANTS && verdictSame) {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-autoplay-mut-')); let pp = Number(process.env.ARENA_OVERLAY_PORT || 8790);
    const results = [];
    for (const mu of MUTANTS) {
      const d = copyTree(PA, path.join(TMP, 'm' + results.length));
      try { mutateFile(d, mu.file, mu.from, mu.to); } catch (e) { C.ok(false, 'mutant ' + mu.id + ' could not be applied', e.message); continue; }
      const ov = await startOverlay({ dir: d, port: pp++, upstream: BASE });
      let failed = [];
      try {
        await withBrowser({ port: cdp, width: 1280, height: 800, autoplay: false, lock: false }, async (page) => {
          await addInit(page, STUB_MODULES_SRC);
          const RM = []; const R = { ok: (c, n) => { if (!c) RM.push(n); } };
          try { await pageCases(page, ov.url, R, 'MUT '); } catch (e) { RM.push('crashed: ' + e.message); }
          failed = RM;
        });
      } finally { ov.stop(); cdp += 4; }
      results.push({ id: mu.id, killed: failed.length > 0, by: failed[0] || null });
    }
    let survived = 0;
    for (const r of results) { console.log((r.killed ? 'killed  ' : 'SURVIVED') + ' ' + r.id + (r.by ? ' -- ' + String(r.by).slice(0, 100) : '  <-- no case failed')); if (!r.killed) survived++; }
    console.log('mutants: ' + (results.length - survived) + '/' + results.length + ' killed');
    if (survived) C.ok(false, survived + ' mutant(s) survived', results.filter((r) => !r.killed).map((r) => r.id).join('; '));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
} finally { L.stopServer(server); }
C.finish();
