#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A LOST INPUT PACKET MUST NOT COST THE ROOM A FRAME — the redundancy window
// and the NAK safety net in lib/netplay.js, cell by cell. No browser.
//
// Every 'ls' carries the last delay+2 frames this console sent (`w`), so on an
// unreliable channel a dropped packet is covered by the next one. A burst that
// outruns the window leaves a hole; a console stalled on it for NAK_AFTER_MS
// sends 'lsnak' and every peer resends what it holds, flagged `rel` for the
// reliable channel. tools/netplay_pace_sim.mjs measures the room-level effect
// (50-150 ms, 0.3% loss: 0.956x on the ordered channel, 1.0000x unreliable).
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync('lib/netplay.js', 'utf8'))();
const L = globalThis.Netplay.Lockstep;
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? ' — ' + d : '')); };
const bad = (n, d) => { fail++; console.log('  FAIL  ' + n + ' — ' + d); };
let now = 1;
const pad = (v) => { const u = new Uint8Array(2); u[0] = v; return u; };
function room(delay) {
  const out = { H: [], G: [] };
  const H = new L({ host: true, peerId: 'H', portCount: 2, padBytes: 2, delay, hashEvery: 0, send: (m) => out.H.push(m), now: () => now });
  const G = new L({ host: false, peerId: 'G', portCount: 2, padBytes: 2, send: (m) => out.G.push(m), now: () => now });
  H.seat('H', 1); H.seat('G', 1);
  const flush = (from, to) => { const q = out[from].splice(0); for (const m of q) to.receive(Object.assign({ peer: from }, m)); return q; };
  flush('H', G);
  H.declareReady('d'); flush('H', G); G.declareReady('d'); flush('G', H); flush('H', G);
  out.H.length = 0; out.G.length = 0;
  return { H, G, out, flush };
}
// 1. the window is on the wire
{
  const { H, out } = room(3);
  for (let i = 0; i < 12; i++) {
    H.receive({ t: 'ls', f: i + 3, i: [[1, 'AAA=']], peer: 'G' });
    const r = H.beginFrame({ 0: pad(i) }); if (r.ready) H.endFrame(null);
  }
  const ls = out.H.filter((m) => m.t === 'ls');
  const last = ls[ls.length - 1];
  // `w` (one entry per frame) or, in a room where everyone reads it, `wr` (runs).
  const framesOf = (m) => Array.isArray(m.w) ? m.w.map((e) => e[0])
    : Array.isArray(m.wr) ? m.wr.flatMap((e) => Array.from({ length: e[1] }, (_, k) => e[0] + k)) : [];
  const fr = last ? framesOf(last) : [];
  (last && fr.length === 4 && fr[3] === last.f - 1)
    ? ok('every-input-message-carries-the-last-delay+2-frames', `f=${last.f}, window ${fr.join(',')} (${last.wr ? 'run-length' : 'per frame'})`)
    : bad('every-input-message-carries-the-last-delay+2-frames', JSON.stringify(last));
}
// 1b. RUN-LENGTH: a pad held across the window costs one run, not one entry a frame
{
  const { H, out } = room(8);
  for (let i = 0; i < 20; i++) {
    H.receive({ t: 'ls', f: i + 8, i: [[1, 'AAA=']], peer: 'G' });
    const r = H.beginFrame({ 0: pad(7) }); if (r.ready) H.endFrame(null);
  }
  const last = out.H.filter((m) => m.t === 'ls').pop();
  (last && Array.isArray(last.wr) && last.wr.length === 1 && last.wr[0][1] === 9 && last.wr[0][2] === 0 && JSON.stringify(last).length < 90)
    ? ok('a-held-pad-is-one-run', `${JSON.stringify(last)} (${JSON.stringify(last).length} B for 10 frames of input)`)
    : bad('a-held-pad-is-one-run', JSON.stringify(last));
}
// 2. a dropped packet is covered by the next one: no stall
{
  const { H, G, out, flush } = room(3);
  let stalls = 0, ran = 0;
  for (let i = 0; i < 60; i++) {
    now += 20;
    const rh = H.beginFrame({ 0: pad(i & 255) }); if (rh.ready) H.endFrame(null);
    const rg = G.beginFrame({ 1: pad(i & 255) }); if (rg.ready) { G.endFrame(null); ran++; } else stalls++;
    // drop every 5th input message from the host, deliver the rest
    const q = out.H.splice(0);
    for (const m of q) { if (m.t === 'ls' && (m.f % 5) === 0) continue; G.receive(Object.assign({ peer: 'H' }, m)); }
    flush('G', H);
  }
  (stalls === 0 && ran === 60)
    ? ok('one-dropped-input-packet-in-five-costs-no-frame', `guest ran ${ran}/60, ${stalls} stalls`)
    : bad('one-dropped-input-packet-in-five-costs-no-frame', `guest ran ${ran}/60, ${stalls} stalls`);
}
// 3. a burst longer than the window: the NAK recovers it, over the reliable channel
{
  const { H, G, out, flush } = room(2);
  let ran = 0, naks = 0, rel = 0;
  for (let i = 0; i < 80; i++) {
    now += 20;
    const rh = H.beginFrame({ 0: pad(i & 255) }); if (rh.ready) H.endFrame(null);
    const rg = G.beginFrame({ 1: pad(i & 255) }); if (rg.ready) { G.endFrame(null); ran++; }
    const q = out.H.splice(0);
    for (const m of q) {
      if (m.t === 'ls' && !m.rel && m.f >= 20 && m.f < 32) continue;   // a 12-frame burst of loss
      if (m.rel) rel++;
      G.receive(Object.assign({ peer: 'H' }, m));
    }
    const qg = out.G.splice(0);
    for (const m of qg) { if (m.t === 'lsnak') naks++; H.receive(Object.assign({ peer: 'G' }, m)); }
  }
  (G.frame > 32 && ran >= 55 && naks > 0 && rel > 0 && G.state !== 'failed')
    ? ok('a-burst-longer-than-the-window-is-recovered-by-a-nak', `guest past the hole (frame ${G.frame}), ran ${ran}/80 after ${naks} nak(s), ${rel} reliable resend(s)`)
    : bad('a-burst-longer-than-the-window-is-recovered-by-a-nak', `ran ${ran}, naks ${naks}, rel ${rel}, state ${G.state}`);
}
// 4. an old-format message (no window) still works
{
  const { G } = room(2);
  G.receive({ t: 'ls', f: 2, i: [[0, 'BQA=']], peer: 'H' });
  const v = G._inputFor(2, 0);
  (v && v[0] === 5) ? ok('a-message-with-no-window-is-read-as-before') : bad('a-message-with-no-window-is-read-as-before', String(v));
}
// 5. a peer may not use the window to write someone else's port
{
  const { G } = room(2);
  G.receive({ t: 'ls', f: 5, i: [[0, 'AQA=']], peer: 'H', w: [[4, [[1, 'CQA=']]]] });
  (G._inputFor(4, 1) === undefined) ? ok('the-window-obeys-port-ownership') : bad('the-window-obeys-port-ownership', 'host wrote port 1 through w');
  G.receive({ t: 'ls', f: 9, i: [[0, 'AQA=']], peer: 'H', wr: [[6, 3, [[1, 'CQA=']]]] });
  (G._inputFor(7, 1) === undefined) ? ok('the-run-length-window-obeys-port-ownership') : bad('the-run-length-window-obeys-port-ownership', 'host wrote port 1 through wr');
}
console.log(`\n[redundancy] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
