#!/usr/bin/env node
// ============================================================================
// netplay_rb_msgcost_test.mjs — WHAT DOES A ROLLBACK ROOM COST ON THE WIRE?
//
// The adaptive room (05d2f48) sent every input with max(8, window) past frames
// (up to 16): an 'ls' went from ~80 B to ~380 B, a two-player room at 100 ms
// from 8.9 to 42.9 KiB/s, a four-player host ~193 KiB/s out — a phone-uplink and
// relay risk (reviewer's msgcost rig). Now the window is run-length encoded
// (lsgo `wr`), 3 frames deep on a path nobody has NAKed, the window depth once
// somebody has; the per-port advantage rides every 4th message.
//
// Measured per FRAME a console runs (the pre-adaptive 4p room ran at ~0.5x, so
// a per-second number would flatter it), on every delivered message, against
// the engine as of the last pre-adaptive commit (git ffc0f52), same seeds.
// CELLS  clean link (0% loss): bytes per frame <= the pre-adaptive engine's;
//        2% loss: reported, and within 2x of pre-adaptive.
// USAGE  node tools/netplay_rb_msgcost_test.mjs
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(process.env.TMPDIR || '/tmp', 'netplay_pre_adaptive_' + process.pid + '.js');
fs.writeFileSync(tmp, execSync('git show ffc0f52:lib/netplay.js', { cwd: root, maxBuffer: 64 << 20 }));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };
function measure(js, cell) {
  const out = execSync(process.execPath + ' --input-type=module', { cwd: root, env: Object.assign({}, process.env, { NETPLAY_JS: js || '' }),
    input: `
      import { simulate } from ${JSON.stringify(path.join(root, 'tools/netplay_rb_pace_sim.mjs'))};
      const L = globalThis.Netplay.Lockstep.prototype; const rx = L.receive; let bytes = 0, lsBytes = 0, ls = 0, hostOut = 0;
      L.receive = function (m) { const b = JSON.stringify(m).length; bytes += b; if (m.t === 'ls') { lsBytes += b; ls++; } if (!this.isHost) hostOut += b; return rx.apply(this, arguments); };
      const r = simulate(${JSON.stringify(Object.assign({ name: 'c', secs: 40 }, cell))});
      const frames = Object.values(r.consoles).reduce((a, c) => a + c.frames, 0);
      console.log(JSON.stringify({ perFrame: bytes / frames, lsPerMsg: lsBytes / ls, kibs: bytes / 40 / 1024, hostOutKibs: hostOut / 40 / 1024, rate: r.minRate }));` }).toString();
  return JSON.parse(out.trim().split('\n').pop());
}
console.log('=== rollback room wire cost: this engine vs the pre-adaptive one (git ffc0f52) ===');
for (const [players, ms, loss] of [[2, 100, 0], [4, 100, 0], [2, 100, 0.02], [4, 100, 0.02]]) {
  const cell = { seed: 3, players, baseMs: ms, jitterMs: 30, loss };
  const pre = measure(tmp, cell), now = measure(null, cell);
  const line = `${players}p@${ms}ms loss ${loss * 100}%: ${now.perFrame.toFixed(1)} B/frame (pre ${pre.perFrame.toFixed(1)}), 'ls' ${now.lsPerMsg.toFixed(0)} B (pre ${pre.lsPerMsg.toFixed(0)}), `
    + `${now.kibs.toFixed(1)} KiB/s all links (pre ${pre.kibs.toFixed(1)} at ${pre.rate}x), host out ${now.hostOutKibs.toFixed(1)} KiB/s (pre ${pre.hostOutKibs.toFixed(1)})`;
  if (loss === 0) ok(`clean-link/${players}p/no-more-bytes-per-frame-than-before`, now.perFrame <= pre.perFrame * 1.0, line);
  else ok(`lossy-link/${players}p/within-2x-of-before`, now.perFrame <= pre.perFrame * 2, line);
}
fs.unlinkSync(tmp);
console.log(`\n[rb-msgcost] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
