#!/usr/bin/env node
// ============================================================================
// n64_rejoin_rig_test.mjs — A PLAYER WHO CLOSES THE TAB, RELOADS, OR LOSES THE CONNECTION COMES BACK LEVEL, FAST, WITH NO FORK.
//
// Real browsers (tools/n64_rejoin_rig.mjs: one Chrome PROCESS per player, local MQTT broker, real WebRTC, Smash Remix), because
// the failures this pins only exist in them:
//   * reopen-lag: a closed-and-reopened page used to come back 5-15 frames BEHIND the room and stay there with the "Rejoining the
//     match" picture held for minutes -- the 1.0167x catch-up ceiling (room_core __n64PaceCeiling) barred closing a gap the replay
//     had not covered, and the own-clock anchor was inert in a rollback room (_rbAtBy is never sent there). A pair at
//     ?pacecap=0 was level; the rig reproduced it 4/4 at 8+ s away.
//   * replay cost: a returning page replayed the match from frame 0 (~200 frames/s). The host now keeps its newest exact state
//     (RS_CK_EVERY) and the page starts there (lib/netplay.js rsCkPut / _ckServe / rsCkLoaded; room_core.js ck*).
//   * host freeze: a closed tab sent nothing; the host froze ~2.6 s (the silence detector) before playing on. The page now says
//     'lsbye' on pagehide.
//   * a dropped connection (RTCPeerConnection.close() / the data channel closing, on either side) recovers by itself.
// Every scenario also compares EVERY frame both consoles ran (the pages' (frame, fingerprint) ring, replayed frames included) and
// fails on a single difference.
//
// USAGE  npm run web   (port 8080), then   node tools/n64_rejoin_rig_test.mjs [--only name,name] [--url http://localhost:8080]
// ============================================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const ONLY = flag('only', '') ? flag('only', '').split(',') : null;
const URL_ = flag('url', 'http://localhost:8080');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'n64-rejoin-'));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };

// level = every sample in the last `hold` s of the run is within `tol` frames of the host, no "Rejoining" message
const SCEN = [
  // name, rig args, expectations { ck: expect a checkpoint start (true) / none (false) / null, levelBy: s after the act, tol, hostStall: max host freeze ms (null = not judged) }
  ['rb-close-long', { mode: 'close', at: 1900, gap: 7000, secs: 38 }, { ck: true, levelBy: 24, tol: 4 }],
  ['rb-close-nock', { mode: 'close', at: 1300, gap: 7000, secs: 45, query: 'nock=1' }, { ck: false, levelBy: 40, tol: 4 }],
  ['rb-tab-close', { mode: 'tab', at: 1000, gap: 8000, secs: 35 }, { levelBy: 30, tol: 4, hostStall: 700 }],
  ['rb-reload', { mode: 'reload', at: 1000, secs: 35 }, { levelBy: 30, tol: 4 }],
  ['rb-pc-drop', { mode: 'pcdrop', at: 600, secs: 30 }, { levelBy: 25, tol: 4, hostStall: 1500 }],
  ['rb-dc-drop', { mode: 'dcdrop', at: 600, secs: 30 }, { levelBy: 25, tol: 4, hostStall: 1500 }],
  ['rb-host-pc-drop', { mode: 'hpcdrop', at: 600, secs: 30 }, { levelBy: 25, tol: 4, hostStall: 1500 }],
  ['rb-3p-tab', { mode: 'tab', at: 900, gap: 6000, secs: 45, joiners: 2 }, { levelBy: 40, tol: 7 }],
  ['delay-close', { mode: 'close', at: 900, gap: 7000, secs: 45, query: 'rb=0' }, { levelBy: 40, tol: 4 }],
  ['delay-pc-drop', { mode: 'pcdrop', at: 600, secs: 30, query: 'rb=0' }, { levelBy: 25, tol: 4 }],
];

console.log('=== a returning / reconnecting N64 player is level with the room, from the real browsers ===');
for (const [name, a, ex] of SCEN) {
  if (ONLY && !ONLY.includes(name)) continue;
  console.log('--- ' + name + '  ' + JSON.stringify(a));
  const args = [path.join(HERE, 'n64_rejoin_rig.mjs'), '--name', name, '--out', OUT, '--url', URL_, '--rowms', '1000'];
  for (const [k, v] of Object.entries(a)) args.push('--' + k, String(v));
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 900000, maxBuffer: 64 << 20 });
  let o = null;
  try { o = JSON.parse(fs.readFileSync(path.join(OUT, name, 'out.json'), 'utf8')); } catch (e) { /* none */ }
  ok(name + '/rig-ran', !!o && !o.error, o ? (o.error || `${(o.rows || []).length} samples`) : ('no out.json: ' + String(r.stderr || r.stdout).slice(-200)));
  if (!o || o.error) continue;
  const rows = o.rows || [];
  const lvl = rows.findIndex((x) => x.d != null && Math.abs(x.d) <= ex.tol && x.t > 0 && !/Rejoining/.test(x.msg || ''));
  ok(name + '/level-in-time', lvl >= 0 && rows[lvl].t <= ex.levelBy, lvl >= 0 ? `level ${rows[lvl].t} s after the act (limit ${ex.levelBy})` : 'never level');
  const tail = rows.slice(-8);
  // (two sequential page reads are never simultaneous: a single sample can be several frames of sampling skew, so the verdict is
  // the median and the share of samples near the tolerance, not one worst sample)
  const ads = tail.map((x) => Math.abs(x.d == null ? 9999 : x.d)).sort((p, q) => p - q);
  const med = ads.length ? ads[ads.length >> 1] : 9999, near = ads.filter((v) => v <= ex.tol + 3).length;
  ok(name + '/stays-level', tail.length > 0 && med <= ex.tol && near >= tail.length - 1, `|host - joiner| over the last ${tail.length} samples: median ${med}, ${near} within ${ex.tol + 3} frames, max ${ads[ads.length - 1]}`);
  ok(name + '/no-held-picture-at-the-end', tail.length > 0 && tail.every((x) => !/Rejoining/.test(x.msg || '')), tail.map((x) => (x.msg || '').slice(0, 10)).slice(-3).join(' | '));
  const cmp = Object.values(o.cmp || {});
  ok(name + '/every-frame-fingerprint-equals-the-host', cmp.length > 0 && cmp.every((c) => c.nBad === 0 && c.compared >= 300), cmp.map((c) => `${c.compared} compared, ${c.nBad} differ${c.firstDiff ? ' first at ' + c.firstDiff.f : ''}`).join('; '));
  if (ex.ck === true) ok(name + '/started-from-the-hosts-checkpoint', o.ckBase > 0, `base frame ${o.ckBase}${o.ckWhy ? ' (not used: ' + o.ckWhy + ')' : ''}`);
  if (ex.ck === false) ok(name + '/control-replayed-from-frame-0', !o.ckBase, `base ${o.ckBase}`);
  if (ex.hostStall != null) ok(name + '/host-did-not-freeze', o.hostStallDelta <= ex.hostStall, `host stalled ${o.hostStallDelta} ms around the event (limit ${ex.hostStall})`);
  const pe = (o.errs || []).flat().filter(Boolean);
  ok(name + '/no-page-errors', pe.length === 0, pe.slice(0, 2).join(' | '));
}
console.log(`\n[n64-rejoin-rig] ${pass}/${pass + fail} passed   (rig output: ${OUT})`);
try { spawnSync(process.execPath, [path.join(HERE, 'browser_leak_guard.js'), 'reap'], { encoding: 'utf8' }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
