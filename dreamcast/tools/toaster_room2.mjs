#!/usr/bin/env node
// ============================================================================
// toaster_room2.mjs — THE ROOM TOASTER AS TWO DEVICES, NOT ONE SHARED BOX.
//
// tools/toaster_bench.mjs's room cell runs both players in ONE browser on one
// 4-core box under one SIGSTOP duty cycle (tools/toaster_duty.py): the two
// consoles take each other's on-slices, so the cell measures "two toasters
// sharing one toaster" — dreamcast/docs/toaster-split/TASKS.md measured that
// sharing alone at -25 to -35% (pair of solos vs solo).
//
// Here each player is its OWN BROWSER (own profile, own process tree) and its
// own device:
//   * CPUSET  — the whole process tree (browser, GPU/SwiftShader, renderers,
//     utilities) is pinned to its own cores: player A cpus 0-1, player B 2-3
//     (cgroup v1 cpuset; children inherit). The two cannot share a core.
//   * SPEED   — every thread of every RENDERER process (page, workers, audio,
//     V8 background threads) gets its own cpu cgroup with a quota of 1/R of one
//     core (cfs period 10 ms): each thread runs at <= 1/R of a core, the same
//     per-thread slowdown the duty cycle imposes, and like it the GPU and browser
//     processes are not slowed. Threads are re-scanned every 300 ms.
//   * PROOF (printed, and the run is VOID without it): Lighthouse BenchmarkIndex
//     (tools/toaster_bench.mjs BENCH_SRC) in a dedicated worker of each browser
//       free      — cpuset only, no quota (median of 5 x 2 s)
//       alone     — quota on, the other browser idle      -> slowdown = free/alone (expect R, +-25%: the
//                   free score alone moves ~15% run to run on this box)
//       together  — quota on, both browsers run it at once -> share = together/alone (expect ~1)
//     plus each cgroup's own cpu.stat nr_throttled (a quota that never bit did nothing).
//   The players talk over the shipped signalling (tools/mqtt_ws_broker.mjs, out of
//   process) and a real WebRTC DataChannel, as dreamcast/tools/room_desync_soak.mjs.
//
// MODES  room   host + joiner (two browsers), PSO seed, bench-style window
//        solo   one browser, the solo bench page        (same device)
//        pair   two browsers, each the solo bench page  (control: two devices, no room)
// The window is lib/bench.js's dreamcast rule: from the first heartbeat with the
// room running (or solo booted), no restore pending and hbSinceRestore >= 2, the
// mean AICA-witness x of the next 20 heartbeats; plus steady = the 2nd half.
//
//   npm run web ; node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node dreamcast/tools/toaster_room2.mjs <room|solo|pair> <rate> <sec> [extra-query]
//        [--jextra Q] [--name N] [--noproof] [--cores 2]
// Output: /tmp/dc-room2/<name>.json (+ screenshots).
// ============================================================================
import { createRequire } from 'module'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawn, execSync } from 'child_process'; import { pathToFileURL, fileURLToPath } from 'url';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const guard = (await import(path.join(ROOT, 'tools/browser_leak_guard.js'))).default;
const a = process.argv.slice(2);
const mode = a[0] || 'room', rate = +a[1] || 6.2, secs = +a[2] || 20, extra = a[3] && !a[3].startsWith('--') ? a[3] : '';
const fl = (n) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : null; };
const name = fl('name') || `${mode}-${rate}`, NOPROOF = a.includes('--noproof'), CORES = +(fl('cores') || 2);
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUTD = '/tmp/dc-room2'; fs.mkdirSync(OUTD, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const ts = () => +((Date.now() - T0) / 1000).toFixed(1);
const say = (s) => console.log(`[${ts()}s] ${s}`);
const out = { name, mode, rate, secs, extra, cores: CORES, load0: os.loadavg(), players: {} };

// ---- cgroups ---------------------------------------------------------------------------
const CPU = '/sys/fs/cgroup/cpu', CPUSET = '/sys/fs/cgroup/cpuset';
const TAG = `dcr2-${process.pid}`;
function kidsMap() {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];
      if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(+d); } catch (e) {}
  }
  return kids;
}
function tree(pid) { const k = kidsMap(), o = [pid], q = [pid]; while (q.length) { for (const c of k.get(q.shift()) || []) { o.push(c); q.push(c); } } return o; }
const ptype = (pid) => { try { const m = /--type=([\w-]+)/.exec(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')); return m ? m[1] : 'browser'; } catch (e) { return null; } };
function makeDevice(P, cpus) {
  const set = path.join(CPUSET, `${TAG}-${P.role}`);
  fs.mkdirSync(set);
  fs.writeFileSync(path.join(set, 'cpuset.mems'), '0');
  fs.writeFileSync(path.join(set, 'cpuset.cpus'), cpus);
  const top = path.join(CPU, `${TAG}-${P.role}`);
  fs.mkdirSync(top);
  P.dev = { set, top, cpus, groups: new Map(), quotaOn: false, frac: 1 / rate };
}
function deviceScan(P) {
  const bpid = P.browser.process().pid;
  for (const pid of tree(bpid)) {
    let tids = []; try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (e) { continue; }
    for (const t of tids) { try { fs.writeFileSync(path.join(P.dev.set, 'tasks'), t); } catch (e) {} }   // cpuset: every thread
    if (ptype(pid) !== 'renderer') continue;
    for (const t of tids) {
      if (P.dev.groups.has(+t)) continue;
      const g = path.join(P.dev.top, 't' + t);
      try {
        fs.mkdirSync(g);
        fs.writeFileSync(path.join(g, 'cpu.cfs_period_us'), '10000');
        fs.writeFileSync(path.join(g, 'cpu.cfs_quota_us'), P.dev.quotaOn ? String(Math.round(10000 * P.dev.frac)) : '-1');
        fs.writeFileSync(path.join(g, 'tasks'), t);
        P.dev.groups.set(+t, g);
      } catch (e) {}
    }
  }
}
function deviceQuota(P, on) {
  P.dev.quotaOn = on;
  for (const g of P.dev.groups.values()) { try { fs.writeFileSync(path.join(g, 'cpu.cfs_quota_us'), on ? String(Math.round(10000 * P.dev.frac)) : '-1'); } catch (e) {} }
}
function deviceStat(P) {
  let thr = 0, nrp = 0, nrt = 0;
  for (const g of P.dev.groups.values()) {
    try { for (const l of fs.readFileSync(path.join(g, 'cpu.stat'), 'utf8').trim().split('\n')) { const [k, v] = l.split(' ');
      if (k === 'nr_periods') nrp += +v; if (k === 'nr_throttled') nrt += +v; if (k === 'throttled_time') thr += +v; } } catch (e) {}
  }
  return { groups: P.dev.groups.size, nr_periods: nrp, nr_throttled: nrt, throttled_s: +(thr / 1e9).toFixed(2) };
}
// every thread of the player's tree really allowed only its cores (the "do not share" proof)
function cpusetProof(P) {
  const seen = new Map();
  for (const pid of tree(P.browser.process().pid)) {
    let tids = []; try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (e) { continue; }
    for (const t of tids) { try { const m = /Cpus_allowed_list:\s*(\S+)/.exec(fs.readFileSync(`/proc/${pid}/task/${t}/status`, 'utf8')); if (m) seen.set(m[1], (seen.get(m[1]) || 0) + 1); } catch (e) {} }
  }
  return Object.fromEntries(seen);
}
async function deviceEnd(P) {
  if (!P.dev) return;
  for (let i = 0; i < 20; i++) {
    let left = 0;
    for (const g of P.dev.groups.values()) { try { fs.rmdirSync(g); } catch (e) { left++; } }
    try { fs.rmdirSync(P.dev.top); fs.rmdirSync(P.dev.set); return; } catch (e) {}
    await sleep(250);
  }
}

// ---- players ---------------------------------------------------------------------------
async function launch(role, cpus) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcr2-${role}-`));
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir, protocolTimeout: 600000,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--js-flags=--max-old-space-size=512', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
           '--window-size=1280,800'] });
  guard.guard(browser, 'dreamcast/tools/toaster_room2.mjs');
  const P = { role, browser, dir, rows: [], lines: [], errs: [] };
  makeDevice(P, cpus);
  deviceScan(P); P.scan = setInterval(() => deviceScan(P), 300);
  P.page = (await browser.pages())[0] || await browser.newPage();
  P.page.on('pageerror', (e) => P.errs.push(String(e.message).slice(0, 200)));
  P.page.on('console', (m) => { const t = m.text();
    if (/\[rollback\]|ARMED|normalize OK|estimated rollback step|desync/i.test(t) && P.lines.length < 200) { const L = `${ts()} ${role} ${t.slice(0, 220)}`; P.lines.push(L); console.log('  ' + L); } });
  const mq = '/tmp/npdm/mqtt-5.3.4.min.js';
  if (!fs.existsSync(mq)) execSync(`mkdir -p /tmp/npdm && curl -sS -f -o ${mq} https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js`);
  await P.page.evaluateOnNewDocument(fs.readFileSync(mq, 'utf8'));
  return P;
}
const BENCH_SRC = `function computeBenchmarkIndex(duration){const halfTime=duration/2;
function gc(){const start=Date.now();let it=0;while(Date.now()-start<halfTime){let s='';for(let j=0;j<10000;j++){s+='a';}if(s.length===1)throw new Error('x');it++;}return Math.round(it/10/((Date.now()-start)/1000));}
function nogc(){const A=[],B=[];for(let i=0;i<100000;i++){A[i]=B[i]=i;}const start=Date.now();let it=0;while(it%10!==0||Date.now()-start<halfTime){const s=it%2===0?A:B,t=it%2===0?B:A;for(let j=0;j<s.length;j++){t[j]=s[j];}it++;}return Math.round(it/10/((Date.now()-start)/1000));}
return (gc()+nogc())/2;}`;
async function benchWorker(P) {
  await P.page.goto(BASE + '/coi-serviceworker.js', { waitUntil: 'load' }).catch(() => {});   // any same-origin page: workers need an origin
  await P.page.evaluate((src) => { const b = new Blob([src + ';self.onmessage=e=>postMessage(computeBenchmarkIndex(e.data));'], { type: 'text/javascript' });
    window.__bw = new Worker(URL.createObjectURL(b)); }, BENCH_SRC);
  await sleep(1200);   // the scanner gives the new thread its group
}
const benchRun = (P, ms) => P.page.evaluate((ms) => new Promise((r) => { window.__bw.onmessage = (e) => r(e.data); window.__bw.postMessage(ms); }), ms);
async function proof(PS) {
  const med = (v) => v.slice().sort((x, y) => x - y)[Math.floor(v.length / 2)];
  const R = {};
  for (const P of PS) await benchWorker(P);
  for (const P of PS) { deviceQuota(P, false); const v = []; for (let i = 0; i < 5; i++) v.push(await benchRun(P, 2000)); R[P.role] = { free: med(v) }; }
  for (const P of PS) deviceQuota(P, true);
  await sleep(300);
  for (const P of PS) { const v = []; for (let i = 0; i < 3; i++) v.push(await benchRun(P, 2000)); R[P.role].alone = med(v); }
  if (PS.length > 1) {
    const tog = await Promise.all(PS.map(async (P) => { const v = []; for (let i = 0; i < 3; i++) v.push(await benchRun(P, 2000)); return med(v); }));
    PS.forEach((P, i) => { R[P.role].together = tog[i]; });
  }
  for (const P of PS) {
    const r = R[P.role];
    r.slowdown = +(r.free / r.alone).toFixed(2);
    if (r.together != null) r.share = +(r.together / r.alone).toFixed(3);
    r.cpuset = cpusetProof(P); r.cg = deviceStat(P);
    say(`PROOF ${P.role}: BenchmarkIndex free ${r.free} alone ${r.alone} together ${r.together ?? '-'} -> slowdown ${r.slowdown}x (want ~${rate}), share ${r.share ?? '-'} (want ~1), cpus ${JSON.stringify(r.cpuset)}, throttled ${r.cg.nr_throttled}/${r.cg.nr_periods} periods`);
    r.ok = Math.abs(r.slowdown / rate - 1) <= 0.25 && (r.share == null || r.share >= 0.9) && Object.keys(r.cpuset).length === 1 && r.cg.nr_throttled > 0;
  }
  return R;
}

// ---- run -------------------------------------------------------------------------------
const probe = () => {
  const q = window.__dcProbe && window.__dcProbe(); if (!q) return null;
  let net = null;
  try { const S = window.Netplay && window.Netplay.sessions; const s = S && S[S.length - 1]; const rep = s && s.ls && s.ls.report && s.ls.report();
    if (rep) net = { st: rep.state, f: rep.frame, rb: rep.rollback ? 1 : 0, d: rep.delay, rs: rep.rollback ? rep.rollback.resimFrames : 0, ds: !!rep.desync, hc: rep.hashesCompared }; } catch (e) {}
  return { hb: q.hb, hbMs: q.hbMs, booted: q.booted, gx: q.guestX, x: q.aicaX, pace: q.pace, rest: q.restoring, hbr: q.hbSinceRestore, net, done: !!window.__benchResult,
           res: window.__benchResult && (window.__benchResult.room || window.__benchResult.solo) };
};
let broker = null; const PS = [];
try {
  const cpusFor = (i) => `${i * CORES}-${i * CORES + CORES - 1}`;
  const roles = mode === 'solo' ? ['A'] : mode === 'pair' ? ['A', 'B'] : ['H', 'J'];
  for (let i = 0; i < roles.length; i++) PS.push(await launch(roles[i], cpusFor(i)));
  if (!NOPROOF) { out.proof = await proof(PS); out.proofOk = Object.values(out.proof).every((r) => r.ok); if (!out.proofOk) say('PROOF FAILED — the run is VOID'); }
  for (const P of PS) deviceQuota(P, true);
  if (mode === 'room') {
    const { startBroker } = await import(pathToFileURL(path.join(ROOT, 'tools', 'mqtt_ws_broker.mjs')).href);
    broker = await startBroker({ port: 0 });
    const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
    const url = (role) => BASE + '/dreamcast.html?np=' + code + '&game=pso2' + (role === 'H' ? '' : '&join=1') + '&signal=ws&wsbroker=' + encodeURIComponent(broker.url) +
      (role === 'H' ? extra : (fl('jextra') != null ? fl('jextra') : extra));
    for (const P of PS) { await P.page.goto(BASE + '/dreamcast.html', { waitUntil: 'domcontentloaded' }); for (let i = 0; i < 60 && !(await P.page.evaluate(() => self.crossOriginIsolated).catch(() => false)); i++) await sleep(300); }
    await PS[0].page.goto(url('H'), { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await PS[1].page.goto(url('J'), { waitUntil: 'domcontentloaded' });
    out.urls = { H: url('H'), J: url('J') };
  } else {
    for (const P of PS) await P.page.goto(`${BASE}/dreamcast.html?bench=1&benchauto=1&benchroom=0&benchsec=${secs}${extra}`, { waitUntil: 'load', timeout: 180000 });
  }
  const tRun = Date.now(), limit = (secs + 300) * 1000;
  let admitted = mode !== 'room';
  while (Date.now() - tRun < limit) {
    await sleep(1000);
    if (!admitted) { const ok = await PS[0].page.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) { b.click(); return true; } return false; }).catch(() => false); if (ok) { admitted = true; say('host pressed Allow'); } }
    let done = true;
    for (const P of PS) {
      const r = await P.page.evaluate(probe).catch(() => null);
      if (!r) { done = false; continue; }
      if (r.booted && (!P.rows.length || P.rows[P.rows.length - 1].hb !== r.hb)) { r.t = ts(); P.rows.push(r); const pc = r.pace || {}, n = r.net;
        console.log(`${r.t} ${P.role} hb${r.hb} x=${(+r.x).toFixed(3)} emu=${pc.emu} gate=${pc.gate} held=${pc.held} drop=${pc.drop} hbr=${r.hbr}${r.rest ? ' REST' : ''}` + (n ? ` net=${n.st} f=${n.f} ${n.rb ? 'RB' : 'd' + n.d} rs=${n.rs} hc=${n.hc}${n.ds ? ' DESYNC' : ''}` : '')); }
      if (mode !== 'room') { if (r.done && !P.res) P.res = r.res; if (!P.res) done = false; }
      else {
        const isRun = (x) => x.booted && x.gx > 0 && !x.rest && x.hbr >= 2 && x.net && (x.net.st === 'running' || x.net.st === 'stalled');
        const i0 = P.rows.findIndex(isRun); if (i0 < 0 || P.rows.length - i0 - 1 < Math.max(20, secs)) done = false;
      }
    }
    if (done) break;
  }
  const mean = (v) => v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  for (const P of PS) {
    const R = P.rows;
    const isRun = (x) => x.booted && x.gx > 0 && !x.rest && x.hbr >= 2 && (mode !== 'room' || (x.net && (x.net.st === 'running' || x.net.st === 'stalled')));
    const i0 = R.findIndex(isRun), all = i0 >= 0 ? R.slice(i0 + 1) : [], win = all.slice(0, 20), steady = all.slice(Math.floor(all.length / 2));
    const tw = (rows) => { const g = rows.reduce((s, r) => s + (r.x || 0) * (r.hbMs || 1000), 0), w = rows.reduce((s, r) => s + (r.hbMs || 1000), 0); return w ? g / w : null; };
    const o = out.players[P.role] = { openT: i0 >= 0 ? R[i0].t : null, win20: { n: win.length, x: mean(win.map((r) => r.x)), xtw: tw(win), gate: mean(win.map((r) => (r.pace || {}).gate || 0)) },
      steady: { n: steady.length, x: mean(steady.map((r) => r.x)), xtw: tw(steady), gate: mean(steady.map((r) => (r.pace || {}).gate || 0)) },
      lastNet: R.length ? R[R.length - 1].net : null, bench: P.res ? P.res.speed : null, cg: deviceStat(P), lines: P.lines, errs: P.errs.slice(0, 8),
      rows: R.map((r) => ({ t: r.t, x: r.x, hbMs: r.hbMs, hbr: r.hbr, pace: r.pace, net: r.net })) };
    say(`SUMMARY ${P.role}: open@${o.openT}s win20 x=${o.win20.x && o.win20.x.toFixed(3)} (n=${o.win20.n}, gate ${o.win20.gate && o.win20.gate.toFixed(0)} ms/s)  steady x=${o.steady.x && o.steady.x.toFixed(3)} (n=${o.steady.n})  bench=${o.bench ?? '-'}  net=${JSON.stringify(o.lastNet)}  throttled ${o.cg.nr_throttled}/${o.cg.nr_periods}`);
    await P.page.screenshot({ path: path.join(OUTD, `${name}-${P.role}.png`) }).catch(() => {});
  }
} catch (e) { say('ERROR ' + (e && e.stack || e)); out.error = String(e && e.message || e); }
finally {
  out.load1 = os.loadavg();
  say('load ' + out.load0.map((x) => x.toFixed(2)).join(' ') + ' -> ' + out.load1.map((x) => x.toFixed(2)).join(' '));
  fs.writeFileSync(path.join(OUTD, name + '.json'), JSON.stringify(out, null, 1));
  for (const P of PS) { clearInterval(P.scan); try { await P.browser.close(); } catch (e) {} }
  for (const P of PS) { await deviceEnd(P); try { fs.rmSync(P.dir, { recursive: true, force: true }); } catch (e) {} }
  try { if (broker) await broker.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
}
