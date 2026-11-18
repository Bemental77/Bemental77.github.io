#!/usr/bin/env node
// tools/pokemonarena_world_browser_test.mjs - pokemonarena/js/world_rom.js in a REAL browser.
//
// The Node test (tools/pokemonarena_world_test.mjs) proves the decoder against the ROM and a hashes-only golden. It
// cannot prove that the same module, loaded by a browser, draws the same pixels: its only word on that is the static
// check W8a (no node: / Buffer / process / DOM in the source). This test closes that gap. It loads world_rom.js by
// import() in a headless, muted Chrome (tools/headless_cdp.mjs: throwaway profile, bare CDP, never the owner's
// browser), runs ONE function (collect, below) there and in this Node process on the same ROM bytes, and compares.
//
// WHAT IT PROVES (and what would make it fail)
//   B0  the ROM on disk is the pinned SoulGold v1.1.1 (otherwise nothing below means anything);
//   B1  the module loads in the page and the page reports no error;
//   B2  cross-engine: the Center picture, its border block, a 320x240 view, every avatar's twelve pictures, the
//       standers, the emotes, six follower Pokemon, the Center's NPCs, one composed frame of the room, the avatar /
//       stander / Center lists, centerInfo and the cleanWalk list are IDENTICAL in Chrome and in Node;
//   B3  ... and equal pokemonarena/world.golden.json (the hashes the contact sheets were looked at for);
//   B4  a canvas takes the pictures as they are: renderView fills two ImageData.data arrays in place, and the room
//       drawn with putImageData + drawImage (under, the NPCs, over) reads back equal to the software frame;
//   B5  a wrong ROM is refused in the page with a WorldRomError (wrong length, wrong title);
//   B6  negative control: the comparison can fail (a tampered expected value is detected);
//   B7  the same again with the CPU throttled 6x (a rough stand-in for a phone): same pixels.
// Timings are PRINTED, never asserted (they depend on the machine's load; the throttle is Chrome's, not a phone).
//
// WHAT IT DOES NOT PROVE: Safari / Firefox, a real phone, memory limits of a low-end device.
//
// USAGE   node tools/pokemonarena_world_browser_test.mjs     (starts tools/devserver.mjs on a free port and Chrome)
// ENV     ARENA_BASE       use an already running server of THIS tree instead (e.g. http://localhost:8080)
//         ARENA_CDP_PORT   CDP port (default: a free one)
//         CHROME_PATH      Chrome binary (headless_cdp.mjs default otherwise)
// The ROM is read from gba/gbaWasm/roms/ (the page fetches it from the server). Writes nothing anywhere. Pure ASCII.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import * as W from '../pokemonarena/js/world_rom.js';
import { PINNED } from '../pokemonarena/js/rom.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ROM_NAME = 'Pokemon SoulGold (v1.1.1).gba';
const ROM_PATH = path.join(root, 'gba', 'gbaWasm', 'roms', ROM_NAME);
const ROM_URL = '/gba/gbaWasm/roms/' + encodeURIComponent(ROM_NAME);
const GOLDEN = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'world.golden.json'), 'utf8'));
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok === true) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? '  -- ' + String(detail).slice(0, 400) : '')); }
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
function killTree(pid) { try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGKILL'); } catch (_e) { /* gone */ } }

/* ================================================================================================ collect */
// Runs in BOTH engines (shipped to the page as source: it may use nothing but its arguments and what a browser and
// Node both have: WebCrypto, performance, typed arrays). Returns plain JSON: hashes, lists, timings.
async function collect(W, rom) {
  const out = { times: {} };
  const hex = (ab) => Array.from(new Uint8Array(ab), (b) => b.toString(16).padStart(2, '0')).join('');
  const cat = (parts) => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  const unhex = (s) => { const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(2 * i, 2), 16); return o; };
  const sha1 = async (...parts) => hex(await crypto.subtle.digest('SHA-1', cat(parts)));
  const timed = (name, fn) => { const t0 = performance.now(); const r = fn(); out.times[name] = Math.round((performance.now() - t0) * 10) / 10; return r; };
  const layers = (r) => sha1(u32(r.width), u32(r.height), r.under, r.over);

  const world = timed('loadWorld', () => W.loadWorld(rom));
  const c = world.center;
  out.center = await layers(timed('renderMap(center), first call', () => world.renderMap(c)));
  out.border = await layers(world.renderBorder(c));
  out.view = await layers(timed('renderView 320x240, new arrays', () => world.renderView(c, -24, -40, 320, 240)));
  const keep = world.renderView(c, 0, 0, 240, 160);
  timed('renderView 240x160 x60, new arrays', () => { for (let i = 0; i < 60; i++) world.renderView(c, i - 30, 0, 240, 160); });
  timed('renderView 240x160 x60, into', () => { for (let i = 0; i < 60; i++) world.renderView(c, i - 30, 0, 240, 160, keep); });
  const av = timed('ow.avatars (first call)', () => world.ow.avatars);
  out.avatars = av.join(',');
  out.standers = world.ow.standers.join(',');
  const twelve = [];
  timed('walker x12 for every avatar', () => { for (const id of av) twelve.push(W.DIRS.flatMap((d) => [0, 1, 2].map((s) => world.ow.walker(id, d, s).rgba))); });
  const each = []; for (const p of twelve) each.push(await sha1(...p));
  out.avatar0 = each[0];
  out.avatarsAll = await sha1(...each.map(unhex));
  out.standersHash = await sha1(...world.ow.standers.flatMap((id) => W.DIRS.map((d) => world.ow.walker(id, d, 0).rgba)));
  out.emotes = {}; for (const e of timed('emotes', () => world.emotes)) out.emotes[e.name] = await sha1(...e.frames);
  out.followers = {}; for (const sp of [113, 25, 1, 6, 150, 249]) out.followers[sp] = await sha1(...W.DIRS.flatMap((d) => [0, 1, 2].map((s) => world.ow.walker(W.GFX.MON | sp, d, s).rgba)));
  const sprites = timed('mapSprites(center)', () => world.mapSprites(c));
  out.centerSprites = await sha1(...sprites.map((s) => s.sprite.rgba));
  const ci = world.centerInfo(c);
  out.centerInfo = JSON.stringify({ doors: ci.doors, counter: ci.counter, counterFloor: ci.counterFloor, nurseTalk: ci.nurseTalk, pc: ci.pc, pcUse: ci.pcUse, regionMap: ci.regionMap, solid: ci.solid });
  out.centers = world.centers.map((x) => x.group + '.' + x.num).join(' ');
  const unclean = []; for (let id = 0; id < world.ow.count; id++) { if (!world.ow.has(id)) continue; const i = world.ow.info(id); if (i.walker && !i.cleanWalk) unclean.push(id); }
  out.unclean = unclean.join(',');
  out.canEnter = [c.canEnter(7, 4, 3), c.canEnter(7, 3, 3), c.canEnter(7, 4, 4), c.walkable(0, 2)].join();

  // one frame of the room composed in software: under, the NPCs top to bottom, over (alpha is 0 or 255 everywhere)
  const v0 = world.renderView(c, 0, 0, 240, 160), frame = v0.under.slice();
  const stamp = (rgba, w, h, x0, y0) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = x0 + x, Y = y0 + y; if (X < 0 || Y < 0 || X >= 240 || Y >= 160) continue; const s = (y * w + x) * 4; if (!rgba[s + 3]) continue; const d = (Y * 240 + X) * 4; frame[d] = rgba[s]; frame[d + 1] = rgba[s + 1]; frame[d + 2] = rgba[s + 2]; frame[d + 3] = 255; } };
  for (const s of sprites) stamp(s.sprite.rgba, s.sprite.width, s.sprite.height, s.px, s.py);
  stamp(v0.over, 240, 160, 0, 0);
  out.frame = await sha1(frame);

  const refused = (bytes) => { try { W.loadWorld(bytes); return 'accepted'; } catch (e) { return e.name; } };
  out.wrongLength = refused(rom.subarray(0, 4096));
  { const bad = rom.slice(); bad[0xa0] ^= 0x10; out.wrongTitle = refused(bad); }

  if (typeof document !== 'undefined') {   // the browser only: a canvas takes the arrays as they are
    const cv = document.createElement('canvas'); cv.width = 240; cv.height = 160;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const U = ctx.createImageData(240, 160), O = ctx.createImageData(240, 160);
    const r = world.renderView(c, 0, 0, 240, 160, { under: U.data, over: O.data });
    out.intoImageData = r.under === U.data && r.over === O.data;
    ctx.putImageData(U, 0, 0);
    const draw = (rgba, w, h, x, y) => { const q = document.createElement('canvas'); q.width = w; q.height = h; q.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0); ctx.drawImage(q, x, y); };
    for (const s of sprites) draw(s.sprite.rgba, s.sprite.width, s.sprite.height, s.px, s.py);
    draw(O.data, 240, 160, 0, 0);
    const got = ctx.getImageData(0, 0, 240, 160).data;
    let diff = 0; for (let i = 0; i < got.length; i++) if (got[i] !== frame[i]) diff++;
    out.canvasDiff = diff;
    out.ua = navigator.userAgent;
  }
  return out;
}
const SHARED = ['center', 'border', 'view', 'avatars', 'standers', 'avatar0', 'avatarsAll', 'standersHash', 'emotes', 'followers', 'centerSprites', 'centerInfo', 'centers', 'unclean', 'canEnter', 'frame', 'wrongLength', 'wrongTitle'];
const differing = (a, b) => SHARED.filter((k) => J(a[k]) !== J(b[k]));
const showTimes = (label, o) => console.log('  info ' + label + ': ' + Object.entries(o.times).map(([k, v]) => k + ' ' + v + ' ms').join('; '));

/* ================================================================================================ run */
if (!fs.existsSync(ROM_PATH)) { console.log('ROM not found at ' + ROM_PATH); process.exit(1); }
const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
console.log('pokemonarena world BROWSER test; ROM', ROM_PATH, rom.length, 'B');
t('B0 the ROM on disk is the pinned SoulGold v1.1.1 (sha256)', crypto.createHash('sha256').update(rom).digest('hex') === PINNED.sha256);

console.log('\n== Node');
const node = await collect(W, rom);
showTimes('Node ' + process.version, node);
t('B3 Node: the Center, the border block and the 320x240 view equal the golden', node.center === GOLDEN.maps['2.0'] && node.border === GOLDEN.border && node.view === GOLDEN.view);
t('B3 Node: collect() hashes the avatars, the standers, the emotes, the followers and the Center NPCs the way the golden does',
  node.avatarsAll === GOLDEN.avatarsAll && node.avatar0 === GOLDEN.avatars['0'] && node.standersHash === GOLDEN.standers && J(node.emotes) === J(GOLDEN.emotes) && J(node.followers) === J(GOLDEN.followers) && node.centerSprites === GOLDEN.centerSprites,
  J({ avatarsAll: node.avatarsAll === GOLDEN.avatarsAll, standers: node.standersHash === GOLDEN.standers, emotes: J(node.emotes) === J(GOLDEN.emotes), followers: J(node.followers) === J(GOLDEN.followers), sprites: node.centerSprites === GOLDEN.centerSprites }));

let server = null;
async function startServer() {
  if (process.env.ARENA_BASE) return process.env.ARENA_BASE.replace(/\/$/, '');
  const port = await freePort();
  server = spawn(process.execPath, [path.join(here, 'devserver.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://localhost:${port}/pokemonarena/js/world_rom.js`); if (r.ok) return `http://localhost:${port}`; } catch (_e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devserver did not come up on ' + port);
}

try {
  const base = await startServer();
  const cdp = Number(process.env.ARENA_CDP_PORT) || await freePort();
  // The page is a plain JSON document of this server (same origin, no script of its own): the module arrives by import().
  const DOC = base + '/pokemonarena/world.golden.json';
  const RUN = `(async () => {
    const W = await import('/pokemonarena/js/world_rom.js');
    const res = await fetch(${J(ROM_URL)});
    if (!res.ok) throw new Error('ROM fetch: HTTP ' + res.status);
    const rom = new Uint8Array(await res.arrayBuffer());
    const collect = ${collect.toString()};
    return JSON.stringify(await collect(W, rom));
  })()`;
  await withBrowser({ port: cdp, width: 800, height: 600 }, async (page) => {
    console.log('\n== headless Chrome');
    await page.navigate(DOC);
    let chrome = null, err = '';
    try { chrome = JSON.parse(await page.eval(RUN)); } catch (e) { err = e.message; }
    const pageErrors = page.errors.filter((e) => !/favicon/i.test(e));
    t('B1 world_rom.js loads in the page by import() and decodes the ROM there, with no page error', !!chrome && pageErrors.length === 0, err || J(pageErrors));
    if (!chrome) return;
    console.log('  info ' + chrome.ua);
    showTimes('Chrome', chrome);
    const d = differing(node, chrome);
    t('B2 Chrome and Node draw the SAME pixels: the Center, its border, a view, every avatar, the standers, the emotes, the followers, the Center NPCs, one composed frame', ['center', 'border', 'view', 'avatar0', 'avatarsAll', 'standersHash', 'emotes', 'followers', 'centerSprites', 'frame'].every((k) => !d.includes(k)), d.join(' '));
    t('B2 Chrome and Node agree on the lists: avatars (' + chrome.avatars.split(',').length + '), standers (' + chrome.standers.split(',').length + '), Centers, centerInfo, cleanWalk, canEnter', ['avatars', 'standers', 'centers', 'centerInfo', 'unclean', 'canEnter'].every((k) => !d.includes(k)), d.join(' '));
    t('B3 Chrome: the Center, the 320x240 view, the avatars and the standers equal the golden', chrome.center === GOLDEN.maps['2.0'] && chrome.view === GOLDEN.view && chrome.avatarsAll === GOLDEN.avatarsAll && chrome.standersHash === GOLDEN.standers);
    t('B4 renderView fills two ImageData.data arrays in place', chrome.intoImageData === true);
    t('B4 the room drawn on a canvas (putImageData under, drawImage the NPCs and over) reads back equal to the software frame', chrome.canvasDiff === 0, chrome.canvasDiff + ' bytes differ');
    t('B5 a wrong ROM is refused in the page with a WorldRomError (wrong length, wrong title)', chrome.wrongLength === 'WorldRomError' && chrome.wrongTitle === 'WorldRomError', chrome.wrongLength + ' / ' + chrome.wrongTitle);
    { const tampered = { ...chrome, center: '0'.repeat(40), avatars: chrome.avatars + ',999' };
      t('B6 negative control: a tampered page result is detected (the Center hash, the avatar list)', J(differing(node, tampered)) === J(['center', 'avatars']), J(differing(node, tampered))); }

    console.log('\n== headless Chrome, CPU throttled 6x');
    await page.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.navigate(DOC + '?slow');
    let slow = null; err = '';
    try { slow = JSON.parse(await page.eval(RUN)); } catch (e) { err = e.message; }
    t('B7 with the CPU throttled 6x the page draws the same pixels and lists', !!slow && differing(node, slow).length === 0 && slow.canvasDiff === 0, err || (slow ? differing(node, slow).join(' ') : ''));
    if (slow) showTimes('Chrome, 6x throttle', slow);
    await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
} catch (e) {
  t('the browser run completes', false, e && e.stack ? e.stack : String(e));
} finally {
  if (server) killTree(server.pid);
}

console.log('\nNOT PROVEN HERE: Safari / Firefox, a real phone, a low-memory device. Timings above are informative only.');
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
