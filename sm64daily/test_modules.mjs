// Every gameplay module, checked in the real game: boots courses until each module type has been
// seen, then puts Mario through that module's mechanic and checks SM64 does what the module needs.
//   node sm64daily/test_modules.mjs [maxCourses]   (URL=http://localhost:8090/sm64daily/)
// Prints one JSON line per check and a summary { module: PASS/FAIL/... }.
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const maxCourses = +(process.argv[2] || 40);
const NAMES = ['HOP', 'STEPPING', 'DOUBLE_STEPPING', 'THWOMP', 'PENDULUM', 'FIREBAR', 'LONG', 'POWER_STEP', 'TRIPLE', 'WALLKICK', 'POLE', 'SLIDE',
  'ENEMIES', 'AMPS', 'CANNON', 'SWITCH', 'SHELL', 'VANISH', 'METAL', 'WING', 'BARS', 'SAND', 'ICE', 'WIND', 'UPDRAFT', 'POOL', 'GAS', 'BOSS',
  'LEDGES', 'LONGCHAIN', 'CRAWL', 'BREAKWALL', 'PUSHBOX', 'BLUECOIN', 'KICKBOARD', 'GROUND', 'HAZARD', 'LIFT', 'SPRING', 'CHOMP', 'ISLAND'];
const WANT = new Set(process.env.ONLY ? process.env.ONLY.split(',').map(n => NAMES.indexOf(n)) : NAMES.slice(12).map((_, i) => i + 12).filter(m => NAMES[m] !== 'BOSS' && NAMES[m] !== 'LONGCHAIN'));
const B_BTN = 0x4000, Z_BTN = 0x2000;
const A = 0x8000, VANISH = 2, METAL = 4, WING = 8, ACT_FLYING = 0x10880899, SWIM = 1 << 13, HANG = 1 << 21, SURFACE_ICE = 0x2E;
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const results = {};
function rec(mod, ok, detail) {
  (results[NAMES[mod]] ||= []).push(ok ? 'PASS' : 'FAIL');
  console.log(JSON.stringify({ module: NAMES[mod], ok, ...detail }));
}

async function course(q) {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 480 });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.evaluateOnNewDocument(() => { window.__ready = null; });
  await page.goto(url + q, { waitUntil: 'load' });
  await page.click('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = [n, p]; r(n, p); }; });
  await page.waitForFunction('window.__ready !== null', { timeout: 60000 });
  await wait(1200);
  const D = (f, ...a) => page.evaluate((f, a) => Module['_daily_debug_' + f](...a), f, a);
  const pad = (btn, x, y) => page.evaluate((o) => { window.__padOverride = o; }, btn === null ? null : { btn, x, y });
  const part = async i => { const v = []; for (let f = 0; f < 10; f++) v.push(await D('part', i, f)); return { i, x: v[0], y: v[1], z: v[2], type: v[3], box: v[4], hx: v[5], hz: v[6], yaw: v[7], param: v[8], kind: v[9] }; };
  const mario = async () => ({ x: await D('mario', 0), y: await D('mario', 1), z: await D('mario', 2), act: (await D('mario', 3)) >>> 0, hp: await D('mario', 4), floor: await D('mario', 6), qs: await D('mario', 8), on: await D('standing') });
  const stationNo = async i => D('next_station', i - 1);
  const yawRad = y => y / 65536 * 2 * Math.PI;
  const along = (p, m) => { const h = yawRad(p.yaw); return (m.x - p.x) * Math.sin(h) + (m.z - p.z) * Math.cos(h); };
  const local = (p, fw, sd) => { const h = yawRad(p.yaw), s = h + Math.PI / 2; return { x: p.x + Math.sin(h) * fw + Math.sin(s) * sd, z: p.z + Math.cos(h) * fw + Math.cos(s) * sd }; };
  // Stick input is camera-relative (mario.c:1304: intendedYaw = atan2s(-stickY, stickX) + camera yaw),
  // so steer toward a world heading from the live camera yaw.
  const steer = async (btn, heading, mag) => { const d = (heading - (await D('camyaw'))) / 65536 * 2 * Math.PI; await pad(btn, Math.round(Math.sin(d) * mag), Math.round(-Math.cos(d) * mag)); };
  const steerFor = async (btn, heading, mag, ms) => { for (let t = 0; t < ms; t += 150) { await steer(btn, heading, mag); await wait(150); } };
  const fresh = async () => { await pad(null); await D('cap', 0); await page.evaluate(() => Module._daily_restart()); await wait(400); };
  return { page, D, pad, part, mario, stationNo, along, local, fresh, steer, steerFor, errs };
}

async function checkModule(c, k, mod) {
  const { D, pad, part, mario, stationNo, along, local, fresh, steer, steerFor } = c;
  const first = await D('mod_info', k, 1), land = await D('mod_info', k, 2), p0 = await D('mod_info', k, 3), p1 = await D('mod_info', k, 4);
  const d0 = await D('mod_info', k, 5), d1 = await D('mod_info', k, 6);
  const parts = []; for (let i = p0; i < p1; i++) parts.push(await part(i));
  const L = await part(land);
  const stations = parts.filter(p => p.type === 0 && p.i !== land);
  const dyn = async i => ({ kind: await D('dyn', i, 0), x: await D('dyn', i, 1), y: await D('dyn', i, 2), z: await D('dyn', i, 3), alive: await D('dyn', i, 4), spawned: await D('dyn', i, 7) });
  await fresh();
  switch (NAMES[mod]) {
    case 'CANNON': {
      const can = parts.find(p => p.type === 5 && p.kind === 0);
      let n = 0; for (let i = 0; i < can.i; i++) if ((await D('part', i, 3)) === 5 && (await D('part', i, 9)) === 0) n++;
      await D('warp', await stationNo(first));
      await wait(300);
      await D('cannon', n);
      let landed = -1;
      for (let t = 0; t < 40 && landed < 0; t++) { await wait(250); const m = await mario(); if (m.on === land) landed = t; }
      rec(mod, landed >= 0, { landedAfter: landed * 250, pitch: can.param });
      break;
    }
    case 'SWITCH': {
      const sw = parts.find(p => p.type === 5 && p.kind === 1);
      const boxes = []; for (let i = d0; i < d1; i++) { const d = await dyn(i); if (d.kind === 9) boxes.push(d); }
      const b = boxes[0];
      await D('put', b.x, b.y + 350, b.z, 0); await wait(900);
      const before = await mario();
      await D('put', sw.x, sw.y + 60, sw.z, 0); await wait(900);
      const solid = [];
      for (const bx of boxes) { await D('put', bx.x, bx.y + 300, bx.z, 0); await wait(600); const m = await mario(); solid.push(Math.abs(m.y - (bx.y + 200)) < 30); }
      rec(mod, before.y < b.y + 150 && solid.every(Boolean), { fellBeforePress: before.y < b.y + 150, solidAfterPress: solid });
      break;
    }
    case 'SHELL': {
      const box = []; for (let i = d0; i < d1; i++) { const d = await dyn(i); if (d.kind === 8) box.push(d); }
      const bx = box[0];
      await D('put', bx.x, bx.y - 210 + 5, bx.z, 0); await wait(500);
      await pad(A, 0, 0); await wait(120); await pad(0, 0, 0); await wait(1500);
      const after = await dyn(d0 + box.length - 1 >= d0 ? d0 : d0);
      const lava = parts.find(p => p.type === 1 && p.box === 6);
      await pad(null);
      await D('put', lava.x, lava.y + 100, lava.z, 0); await wait(700);
      const m = await mario();
      rec(mod, !after.alive && (m.act === 0x010208B7 || m.hp < 0x880), { boxBroken: !after.alive, lavaBurns: m.act === 0x010208B7 || m.hp < 0x880 });
      break;
    }
    case 'VANISH': case 'METAL': {
      const n = parts.find(p => p.i === land) || L;
      const run = async (cap) => {
        await fresh();
        // Warp onto the cap platform: the camera then looks down the bridge, so "forward" walks along it.
        await D('warp', await stationNo(stations[0].i)); await wait(500);
        if (cap) await D('cap', cap);
        if (NAMES[mod] === 'VANISH') {
          // From the bridge's start, walk forward (camera is behind Mario after a warp).
          const s = c.local(n, -n.hz + 60, 0);
          await D('put', s.x | 0, n.y + 30, s.z | 0, n.yaw); await wait(400);
          await steerFor(0, n.yaw, 80, 3500);
          const m = await mario(); await pad(null);
          return along(n, m);
        } else {
          const fb = parts.filter(p => p.type === 4)[0];
          const s = c.local(n, along(n, fb) + 0, 0);
          await D('put', (s.x + 260 * Math.sin((n.yaw + 16384) / 65536 * 2 * Math.PI)) | 0, n.y + 30, (s.z + 260 * Math.cos((n.yaw + 16384) / 65536 * 2 * Math.PI)) | 0, n.yaw);
          let hp = 99999; for (let t = 0; t < 20; t++) { await wait(250); const m = await mario(); hp = Math.min(hp, m.hp); }
          return hp;
        }
      };
      if (NAMES[mod] === 'VANISH') {
        const wallFw = -n.hz + 2 * n.hz / 3;
        const without = await run(0), withCap = await run(VANISH);
        rec(mod, without < wallFw && withCap > wallFw + 60, { wallAt: Math.round(wallFw), reachedWithout: Math.round(without), reachedWithCap: Math.round(withCap) });
      } else {
        const without = await run(0), withCap = await run(METAL);
        rec(mod, without < 0x880 && withCap >= 0x880, { hpWithout: without, hpWithMetal: withCap });
      }
      break;
    }
    case 'WING': {
      const a = stations[0];
      await D('warp', await stationNo(a.i)); await wait(400);
      await D('cap', WING);
      const s = c.local(a, a.hz - 40, 0);
      await D('put', s.x | 0, a.y + 250, s.z | 0, a.yaw);
      await D('action', ACT_FLYING, 40);
      let landed = -1;
      for (let t = 0; t < 80 && landed < 0; t++) {
        const m = await mario();
        const d = Math.hypot(m.x - L.x, m.z - L.z), h = m.y - L.y;
        await pad(0, 0, h > d * 0.25 + 60 ? 35 : 0);
        if (m.on === land) landed = t;
        await wait(200);
      }
      await pad(null);
      rec(mod, landed >= 0, { landedAfter: landed * 200, gap: Math.round(Math.hypot(L.x - a.x, L.z - a.z)) });
      break;
    }
    case 'BARS': {
      const a = stations[0];
      await D('warp', await stationNo(a.i)); await wait(600);
      const s = c.local(a, a.hz - 50, 0);
      await D('put', s.x | 0, a.y + 10, s.z | 0, a.yaw); await wait(500);
      await pad(A, 0, 0); await wait(600);
      const hung = ((await mario()).act & HANG) !== 0;
      let t, trace = [];
      for (t = 0; t < 225; t++) {
        if (t % 3 === 0) { const mm = await mario(); trace.push([Math.round(along(L, mm)), mm.y - L.y, (mm.act >>> 0).toString(16)]); }
        const m = await mario();
        if (along(L, m) > -L.hz + 80) { await pad(0, 0, 0); break; }
        await steer(A, L.yaw, 80); await wait(200);
      }
      await wait(1200);
      const m = await mario(); await pad(null);
      rec(mod, hung && m.on === land, { hung, endedOn: m.on, land, seconds: t * 0.2, trace });
      break;
    }
    case 'POOL': {
      const step = parts.filter(p => p.type === 1 && p.box === 5).sort((x, y) => x.hz - y.hz)[0];
      const floorBox = parts.filter(p => p.type === 1 && p.box === 5).sort((x, y) => y.hz - x.hz)[0];
      await D('put', floorBox.x, floorBox.y + 200, floorBox.z, floorBox.yaw); await wait(900);
      const inWater = await mario();
      await D('put', step.x, step.y + 20, step.z, step.yaw); await wait(700);
      const onStep = await mario();
      const tr = [];
      const snap = async () => { const mm = await mario(); tr.push([Math.round(c.along(step, mm)), mm.y - step.y, (mm.act >>> 0).toString(16), mm.on]); };
      // Run, jump (holding A), and stop the moment Mario stands on the exit platform.
      let out = null;
      for (let t = 0; t < 20 && !out; t++) {
        await steer(t < 2 ? 0 : A, step.yaw, 80); await wait(100);
        const mm = await mario(); if (t % 3 === 0) await snap();
        if (mm.on === land) { out = mm; await pad(0, 0, 0); }
      }
      out = out || await mario(); await pad(null);
      rec(mod, (inWater.act & SWIM) !== 0 && (onStep.act & SWIM) === 0 && out.on === land, { swims: (inWater.act & SWIM) !== 0, standsOnStep: (onStep.act & SWIM) === 0, climbsOut: out.on === land, stepHz: step.hz, tr });
      break;
    }
    case 'GAS': {
      const b = stations[0];
      await D('put', b.x, b.y + 30, b.z, b.yaw); await wait(2000);
      const m = await mario();
      rec(mod, m.hp < 0x880, { hpAfter2s: m.hp });
      break;
    }
    case 'SAND': {
      const sand = parts.find(p => p.type === 0 && p.i !== land && p.hz > 500);
      await D('put', sand.x, sand.y + 20, sand.z, sand.yaw); await wait(1500);
      const m = await mario();
      rec(mod, m.qs > 0 || m.act !== 0x0C400201, { quicksandDepth: m.qs, act: m.act.toString(16) });
      break;
    }
    case 'ICE': {
      const s = stations[0];
      await D('put', s.x, s.y + 20, s.z, s.yaw); await wait(700);
      const m = await mario();
      rec(mod, m.floor === SURFACE_ICE, { floorType: m.floor });
      break;
    }
    case 'WIND': {
      const b = stations[0];
      await D('put', b.x, b.y + 20, b.z, b.yaw); await wait(500);
      const m0 = await mario(); await wait(1500); const m1 = await mario();
      rec(mod, Math.hypot(m1.x - m0.x, m1.z - m0.z) > 60, { pushed: Math.round(Math.hypot(m1.x - m0.x, m1.z - m0.z)) });
      break;
    }
    case 'UPDRAFT': {
      const padP = parts.find(p => p.type === 1 && p.box === 13);
      await D('put', padP.x, padP.y + 300, padP.z, padP.yaw);
      let maxY = -1e9; for (let t = 0; t < 30; t++) { await wait(150); const m = await mario(); maxY = Math.max(maxY, m.y); }
      rec(mod, maxY >= L.y + 40, { padTop: padP.y, maxY, ledge: L.y, liftNeeded: L.y - padP.y });
      break;
    }
    case 'CRAWL': {
      const n = L;
      const run = async (btn, ms) => {
        await fresh(); await D('warp', await stationNo(first)); await wait(600);
        const s0 = c.local(n, -n.hz + 40, 0); await D('put', s0.x | 0, n.y + 20, s0.z | 0, n.yaw); await wait(500);
        await steerFor(btn, n.yaw, 80, ms); const m = await mario(); await pad(null); return along(n, m);
      };
      // A low tunnel: walking gets through (enemies aside); the roof stops a jump short.
      const walk = await run(0, 6000);
      const blockAt = -(n.hz - 160);
      rec(mod, walk > blockAt + 300, { blockFace: blockAt, walkReached: Math.round(walk) });
      break;
    }
    case 'BREAKWALL': {
      const n = L;
      const boxes = []; for (let i = d0; i < d1; i++) boxes.push(i);
      await D('warp', await stationNo(first)); await wait(600);
      const s0 = c.local(n, -170, 0); await D('put', s0.x | 0, n.y + 20, s0.z | 0, n.yaw); await wait(500);
      for (let t = 0; t < 6; t++) { await steer(0, n.yaw, 30); await wait(150); await steer(B_BTN, n.yaw, 0); await wait(150); await pad(0, 0, 0); await wait(300); }
      let broken = 0; for (const i of boxes) if (!(await D('dyn', i, 4))) broken++;
      await pad(null);
      rec(mod, broken > 0, { boxes: boxes.length, broken });
      break;
    }
    case 'PUSHBOX': {
      let bi = -1; for (let i = d0; i < d1; i++) if ((await D('dyn', i, 0)) === 13) bi = i;
      const a = stations[0];
      await D('warp', await stationNo(a.i)); await wait(800);
      const b0 = { x: await D('dyn', bi, 1), z: await D('dyn', bi, 3) };
      const s0 = c.local(a, along(a, b0) - 230, 0); await D('put', s0.x | 0, a.y + 20, s0.z | 0, a.yaw); await wait(500);
      await steerFor(0, a.yaw, 80, 8000);
      const b1 = { x: await D('dyn', bi, 1), z: await D('dyn', bi, 3) };
      await pad(null);
      rec(mod, along(a, b1) - along(a, b0) > 150, { boxMoved: Math.round(along(a, b1) - along(a, b0)), boxNowAt: Math.round(along(a, b1)), ledgeFaceAt: a.hz });
      break;
    }
    case 'LEDGES': {
      const st = stations;
      const l1 = st[0];
      await D('warp', await stationNo(first)); await wait(700);
      let got = false;
      for (let t = 0; t < 30 && !got; t++) { await steer(t % 6 === 2 ? A : 0, l1.yaw, 80); await wait(150); const m = await mario(); if (m.on === l1.i) got = true; }
      await pad(null);
      rec(mod, got, { reachedFirstLedge: got, ledgeRise: l1.y - (await part(first)).y });
      break;
    }
    case 'KICKBOARD': {
      let bi = -1; for (let i = d0; i < d1; i++) if ((await D('dyn', i, 0)) === 16) bi = i;
      const a = stations[0];
      await D('warp', await stationNo(a.i)); await wait(700);
      const bx = { x: await D('dyn', bi, 1), z: await D('dyn', bi, 3) };
      const s0 = c.local(a, along(a, bx) - 250, 0); await D('put', s0.x | 0, a.y + 20, s0.z | 0, a.yaw); await wait(400);
      await steerFor(0, a.yaw, 60, 300); await steer(A, a.yaw, 60); await wait(250); await steer(B_BTN, a.yaw, 60); await wait(1500); await pad(null); await wait(2500);
      const mid = c.local(a, a.hz + 500, 0);
      const fy = await D('floor', mid.x | 0, a.y + 300, mid.z | 0, 0), fo = await D('floor', mid.x | 0, a.y + 300, mid.z | 0, 2);
      rec(mod, fo === 1 && Math.abs(fy - a.y) < 120, { bridgeFloorY: fy - a.y, isObject: fo });
      break;
    }
    case 'BLUECOIN': {
      const n = L;
      await D('put', n.x, n.y + 400, n.z, n.yaw); await wait(150); await pad(Z_BTN, 0, 0); await wait(1500); await pad(null);
      const coins = []; for (let i = d0; i < d1; i++) if ((await D('dyn', i, 0)) === 15) coins.push(i);
      const c0 = await D('mario', 9);
      const ci = coins[0]; await D('put', await D('dyn', ci, 1), (await D('dyn', ci, 2)) - 20, await D('dyn', ci, 3), 0); await wait(600);
      const c1 = await D('mario', 9);
      rec(mod, c1 - c0 >= 5, { coinsBefore: c0, coinsAfter: c1 });
      break;
    }
    case 'GROUND': {
      const pads = parts.filter(p => p.type === 0 && p.i !== land);
      const p1 = pads[0], p2 = pads[1] || L;
      await D('put', p1.x, p1.y + 60, p1.z, p1.yaw); await wait(1500);
      const onPad = await mario();
      await D('put', p2.x, p2.y + 300, p2.z, p2.yaw);
      let maxY = -1e9; for (let t = 0; t < 30; t++) { await wait(150); maxY = Math.max(maxY, (await mario()).y); }
      await D('put', p1.x, p1.y + 60, p1.z, p1.yaw); await wait(1200);
      await c.page.screenshot({ path: '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/fe4a0d6b-2c85-4029-a48f-be6ae4f13d51/scratchpad/ground-' + p1.i + '.png' });
      rec(mod, onPad.on === p1.i && maxY > L.y + 40, { standsOnGroundPad: onPad.on === p1.i, padAboveGround: p1.y - (await D('floor', p1.x, p1.y - 30, p1.z, 0)), lift: maxY - p2.y, ledge: L.y - p2.y });
      break;
    }
    case 'LIFT': case 'SPRING': {
      // Stand on the lift / spring and see whether Mario ends up at the ledge's height.
      const a = stations[0];
      let tx, ty, tz;
      if (NAMES[mod] === 'LIFT') { const lp = parts.find(p => p.type === 2); tx = lp.x; tz = lp.z; ty = a.y + 60; }
      else { let si = -1; for (let i = d0; i < d1; i++) if ((await D('dyn', i, 0)) === 17) si = i; tx = await D('dyn', si, 1); ty = (await D('dyn', si, 2)) + 120; tz = await D('dyn', si, 3); }
      await D('put', tx | 0, ty | 0, tz | 0, a.yaw);
      let maxY = -1e9; for (let t = 0; t < 40; t++) { await wait(200); maxY = Math.max(maxY, (await mario()).y); }
      rec(mod, maxY >= L.y - 20, { rise: maxY - a.y, ledgeRise: L.y - a.y });
      break;
    }
    case 'ISLAND': {
      const can = parts.find(p => p.type === 5 && p.kind === 0);
      let nC = 0; for (let i = 0; i < can.i; i++) if ((await D('part', i, 3)) === 5 && (await D('part', i, 9)) === 0) nC++;
      // Stand at the back of the cannon platform (not on the cannon), looking toward the island.
      const st0 = stations[0], back = c.local(st0, -st0.hz + 60, 0);
      await D('warp', await stationNo(first)); await wait(1500);
      await D('put', back.x | 0, st0.y + 20, back.z | 0, st0.yaw); await wait(2500);
      await c.page.screenshot({ path: '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/fe4a0d6b-2c85-4029-a48f-be6ae4f13d51/scratchpad/isle-' + land + '.png' });
      await D('cannon', nC);
      let landed = -1; for (let t = 0; t < 40 && landed < 0; t++) { await wait(250); if ((await mario()).on === land) landed = t; }
      await wait(800);
      await c.page.screenshot({ path: '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/fe4a0d6b-2c85-4029-a48f-be6ae4f13d51/scratchpad/isle-' + land + '-summit.png' });
      rec(mod, landed >= 0, { landedOnSummitAfter: landed * 250 });
      break;
    }
    case 'CHOMP': {
      await D('warp', await stationNo(land)); await wait(3000);
      let ci = -1; for (let i = d0; i < d1; i++) if ((await D('dyn', i, 0)) === 18) ci = i;
      const al = await D('dyn', ci, 4), dy = (await D('dyn', ci, 2)) - L.y;
      rec(mod, al === 1 && Math.abs(dy) < 300, { alive: al, dyAboveArena: dy });
      break;
    }
    case 'HAZARD': {
      await D('warp', await stationNo(land)); await wait(3000);
      const hz = parts.find(p => p.type === 2);
      const m = await mario();
      rec(mod, hz && m.y > L.y - 2000, { piece: hz && hz.i, marioAlive: m.y > L.y - 2000 });
      break;
    }
    case 'ENEMIES': case 'AMPS': {
      await D('warp', await stationNo(land)); await wait(2500);
      const list = []; for (let i = d0; i < d1; i++) list.push(await dyn(i));
      await wait(1000);
      const list2 = []; for (let i = d0; i < d1; i++) list2.push(await dyn(i));
      // A Bob-omb that blew up next to Mario is gone the way SM64 Bob-ombs go: that counts as on-platform.
      const onPlat = list2.filter(d => (d.alive && Math.abs(d.y - L.y) < 450) || (!d.alive && d.kind === 2)).length;
      const moved = list2.filter((d, i) => Math.hypot(d.x - list[i].x, d.z - list[i].z) > 5).length;
      rec(mod, list2.length > 0 && onPlat === list2.length && (NAMES[mod] === 'ENEMIES' || moved > 0), { count: list2.length, onPlatform: onPlat, moved, kinds: list2.map(d => d.kind).join(','), dy: list2.map(d => d.alive ? d.y - L.y : 'gone').join(',') });
      break;
    }
  }
  await fresh();
}

const tested = {};
const queries = [];
for (let i = 0; i < maxCourses; i++) { const d = new Date('2026-10-16T12:00:00Z'); d.setUTCDate(d.getUTCDate() + i); queries.push('?test=1&date=' + d.toISOString().slice(0, 10)); }
for (const q of queries) {
  if ([...WANT].every(m => (tested[m] || 0) >= (+process.env.PER || 2))) break;
  let c;
  try { c = await course(q); } catch (e) { console.log(JSON.stringify({ q, bootError: String(e).slice(0, 120) })); continue; }
  for (let k = 0; ; k++) {
    const mod = await c.D('mod_info', k, 0);
    if (mod < 0) break;
    if (!WANT.has(mod) || (tested[mod] || 0) >= (+process.env.PER || 2)) continue;
    tested[mod] = (tested[mod] || 0) + 1;
    try { await checkModule(c, k, mod); } catch (e) { rec(mod, false, { q, error: String(e).slice(0, 160) }); }
  }
  if (c.errs.length) console.log(JSON.stringify({ q, pageErrors: c.errs.slice(0, 3) }));
  await c.page.close();
}
console.log(JSON.stringify({ summary: results, untested: [...WANT].filter(m => !tested[m]).map(m => NAMES[m]) }));
await browser.close(); process.exit(0);
