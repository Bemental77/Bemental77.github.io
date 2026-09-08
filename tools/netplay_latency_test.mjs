#!/usr/bin/env node
// HOW LONG DOES PLAYER 2's BUTTON TAKE TO REACH THE GAME?
//
// Online play lives or dies on this number, and "it feels fast" is not a
// number. Measured end to end: the guest's key goes down, and the clock stops
// when the HOST's session reports that pad byte. That covers the whole path —
// the guest's input pump, the DataChannel, and the host's read — which is
// exactly the path a player feels.
//
// ⚠ WHAT THIS DOES NOT INCLUDE. Both browsers are on one machine, so the wire
// is loopback and the ICE path is host-candidate. Real play adds the network
// RTT between the two players (and, if they ever need a relay, a second hop
// through it). So this is the FLOOR the software imposes, not the latency a
// player will see — read it as "what we add on top of the network", and the
// only honest way to get the rest is two real machines.
//
// USAGE  npm run web && node tools/netplay_latency_test.mjs
import puppeteer from 'puppeteer';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const REPS = Number(process.env.REPS || 40);
const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
try { (await import('./browser_leak_guard.js')).default.guard(b, 'netplay_latency'); } catch (_e) {}
const mk = async () => {
  const p = await b.newPage();
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return p;
};
const host = await mk(), guest = await mk();
const CODE = 'LATNC';
const boot = (p, isHost) => p.evaluate(async (code, isHost) => {
  const s = new Netplay.Session({ game: 'g', host: isHost, code, transport: 'local', delayFrames: 0 });
  window.__s = s;
  if (isHost) s.on('join-request', (r) => r.approve());
  await s.start();
}, CODE, isHost);
await boot(host, true); await boot(guest, false);
for (let i = 0; i < 60 && !(await host.evaluate(() => window.__s.state === 'connected')); i++) await new Promise(r => setTimeout(r, 250));
if (!(await host.evaluate(() => window.__s.state === 'connected'))) { console.log('FAIL: never connected'); await b.close(); process.exit(1); }

const samples = [];
for (let i = 0; i < REPS; i++) {
  const want = (i % 250) + 1;                       // a fresh value each rep
  // ⚠ ONE CLOCK, NOT TWO. performance.now() is measured from each PAGE's own
  // time origin, so subtracting one page's reading from another's returns the
  // gap between their origins plus the latency — indistinguishable from the
  // latency itself. The first version of this rig did exactly that and reported
  // a rock-steady 441.0-441.9 ms across every sample, which is the tell: real
  // latency varies, a constant offset does not. performance.timeOrigin is the
  // epoch each page counts from, so origin+now() is the same absolute scale in
  // both pages.
  // ⚠ AND NOT BY POLLING. A `for(;;) await setTimeout(0)` loop looks like a
  // tight spin but Chrome clamps a nested setTimeout to 4 ms, so a poll-based
  // rig CANNOT resolve anything faster than that — the 4.7 ms "p50" the first
  // version printed was its own timer floor, reported as if it were the
  // network. The arrival is stamped in the DataChannel's own message handler
  // instead, which is the moment the byte is actually in hand.
  const t1p = host.evaluate((v) => new Promise((res) => {
    const dc = window.__s._dc;
    const prev = dc.onmessage;
    dc.onmessage = (e) => {
      const t = performance.timeOrigin + performance.now();
      if (prev) prev.call(dc, e);
      let m = null; try { m = JSON.parse(e.data); } catch (_) {}
      if (m && m.t === 'pad' && (m.v | 0) === v) { dc.onmessage = prev; res(t); }
    };
    setTimeout(() => { dc.onmessage = prev; res(-1); }, 3000);
  }), want);
  await new Promise((r) => setTimeout(r, 5));           // let the host's hook be armed
  const t0 = await guest.evaluate((v) => { const t = performance.timeOrigin + performance.now(); window.__s.sendPad(v); return t; }, want);
  const t1 = await t1p;
  if (t1 > 0) samples.push({ ms: t1 - t0, rep: i });
  await new Promise(r => setTimeout(r, 25));
}
// ⚠ THE FIRST MESSAGE IS NOT LIKE THE OTHERS, and averaging it in hides both
// facts. Every run shows exactly one ~415-419 ms sample and it is always rep 0:
// the DataChannel's first send after the session connects pays a one-off cost
// the rest do not. Reported separately, never silently dropped.
const first = samples.length && samples[0].rep === 0 ? samples[0].ms : null;
const steady = samples.filter((x) => x.rep > 0).map((x) => x.ms).sort((a, c) => a - c);
const pct = (q) => steady[Math.min(steady.length - 1, Math.floor(steady.length * q))].toFixed(2);
const mean = (steady.reduce((a, c) => a + c, 0) / steady.length).toFixed(2);
const allMax = Math.max.apply(null, samples.map((x) => x.ms));
const maxRep = samples.find((x) => x.ms === allMax).rep;
console.log(`\nguest key -> host sees it, over a real WebRTC DataChannel, ${samples.length}/${REPS} samples`);
console.log(`  steady state (reps 1..${REPS - 1}):  p50 ${pct(0.5)} ms   p90 ${pct(0.9)} ms   p99 ${pct(0.99)} ms   mean ${mean} ms   min ${steady[0].toFixed(2)}   max ${steady[steady.length - 1].toFixed(2)}`);
console.log(`  first send after connect: ${first === null ? 'n/a' : first.toFixed(2) + ' ms'}   (slowest overall was rep ${maxRep} at ${allMax.toFixed(2)} ms)`);
console.log('  (loopback: the software floor, with no network RTT between two players added)');
// A frame at 60 Hz is 16.67 ms. Anything at or under one frame is not what a
// player will notice; the network between two houses will dominate.
const p90 = Number(pct(0.9));
console.log(p90 < 16.67 ? 'PASS  the software adds less than one 60 Hz frame at p90' : `FAIL  the software alone adds ${p90} ms at p90, more than a 60 Hz frame`);
await b.close();
process.exit(p90 < 16.67 ? 0 : 1);
