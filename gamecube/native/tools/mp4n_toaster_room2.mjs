#!/usr/bin/env node
// ============================================================================
// mp4n_toaster_room2.mjs — MARIO PARTY 4 ROOM / SOLO ON TWO TOASTERS, NATIVE vs RECOMP.
//
// A port of n64/tools/n64_toaster_room2.mjs (itself dreamcast/tools/toaster_room2.mjs): each player
// is its OWN BROWSER on its OWN cores (cgroup v1 cpuset: A cpus 0-1, B 2-3), every renderer thread
// capped at 1/R of a core and the GPU process (SwiftShader) at CORES/R cores in ONE group — the
// same device model, BenchmarkIndex + raster proofs and VOID rule. Players pair over the shipped
// signalling (tools/mqtt_ws_broker.mjs) and a real WebRTC DataChannel.
//
// --page native   mp4-native.html  (the native port; room = mp4n_room.js rollback)
// --page recomp   gamecube.html    (Mario Party 4 on the recomp engine; its own room)
// Both get SwiftShader Vulkan WebGPU (the native port needs it; the recomp page gets the same).
//
// MODES  room   host + joiner
//        solo   one browser, solo game; guest rate from the page's own frame counter
// PER SECOND, per player: x = guest frames / s / 60 (native: room live frames, or mp4web_total
// solo; recomp: PAD_ACK guestFrames), and presented frames / s (native: frames Aurora drew,
// mp4web_drawn; recomp: __gcRate shown / ackedPerS / published, as lib/bench.js reads them). The first --skip s after both run are discarded; then --secs s are measured.
//
//   npm run web ; node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node gamecube/native/tools/mp4n_toaster_room2.mjs <room|solo> <rate> <sec> --page native|recomp
//        [--noproof] [--cores 2] [--gpuoff] [--skip 10] [--name N]
// Output: /tmp/mp4-room2/<name>.json (+ screenshots).
// ============================================================================
import { createRequire } from 'module'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawn, execSync } from 'child_process'; import { pathToFileURL, fileURLToPath } from 'url';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const guard = (await import(path.join(ROOT, 'tools/browser_leak_guard.js'))).default;
const a = process.argv.slice(2);
const mode = a[0] || 'room', rate = +a[1] || 6.2, secs = +a[2] || 20, extra = a[3] && !a[3].startsWith('--') ? a[3] : '';
const fl = (n) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : null; };
const SKIP = +(fl('skip') || 10), PAGE = fl('page') || 'native';
const name = fl('name') || `${PAGE}-${mode}-${rate}`, NOPROOF = a.includes('--noproof'), CORES = +(fl('cores') || 2), GPUOFF = a.includes('--gpuoff');
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUTD = '/tmp/mp4-room2'; fs.mkdirSync(OUTD, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const ts = () => +((Date.now() - T0) / 1000).toFixed(1);
const say = (s) => console.log(`[${ts()}s] ${s}`);
const out = { name, page: PAGE, mode, rate, secs, extra, cores: CORES, gpuThrottle: !GPUOFF, load0: os.loadavg(), players: {} };

// ---- cgroups ---------------------------------------------------------------------------
const CPU = '/sys/fs/cgroup/cpu', CPUSET = '/sys/fs/cgroup/cpuset';
const TAG = `mp4r2-${process.pid}`;
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
// CPU seconds per Chrome process type (renderer / gpu-process / utility / browser), from /proc utime+stime
const HZ = 100;
// per pid (a process that exits between two readings takes its CPU with it, so deltas are per pid)
function cpuByType(P) {
  const o = {}; let bpid; try { bpid = P.browser.process().pid; } catch (e) { return o; }
  for (const pid of tree(bpid)) {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      o[pid] = { t: (+f[11] + +f[12]) / HZ, k: ptype(pid) || '?' }; } catch (e) {}
  }
  return o;
}
function makeDevice(P, cpus) {
  const set = path.join(CPUSET, `${TAG}-${P.role}`);
  fs.mkdirSync(set);
  fs.writeFileSync(path.join(set, 'cpuset.mems'), '0');
  fs.writeFileSync(path.join(set, 'cpuset.cpus'), cpus);
  const top = path.join(CPU, `${TAG}-${P.role}`);
  fs.mkdirSync(top);
  P.dev = { set, top, cpus, groups: new Map(), mult: new Map(), quotaOn: false, frac: 1 / rate };
}
function deviceScan(P) {
  const bpid = P.browser.process().pid;
  for (const pid of tree(bpid)) {
    let tids = []; try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (e) { continue; }
    for (const t of tids) { try { fs.writeFileSync(path.join(P.dev.set, 'tasks'), t); } catch (e) {} }   // cpuset: every thread
    const pt = ptype(pid);
    if (pt !== 'renderer' && (GPUOFF || pt !== 'gpu-process')) continue;
    // The GPU process is ONE group with a quota of CORES/R cores, all its threads together:
    // SwiftShader rasterises on several threads in parallel, and a per-thread 1/R cap let 4
    // threads take 4/R of the device (measured: raster slowed 3.49x at R=6.2). A device R
    // times slower gives the whole rasterizer CORES/R cores.
    const gpuG = pt === 'gpu-process' ? path.join(P.dev.top, 'g' + pid) : null;
    for (const t of tids) {
      if (P.dev.groups.has(+t)) continue;
      // Renderer threads: each its own group (a thread is R times slower) INSIDE one group capped at
      // CORES/R for all of them together (the device has CORES cores, each R times slower). Without the
      // shared cap, N busy threads got N/R: measured, the recomp page runs ~5 busy dedicated workers,
      // each at the 1/R per-thread quota, so it had up to 5/6.2 of a core where native's one game thread
      // had 1/6.2.
      const rG = path.join(P.dev.top, 'r');
      if (!gpuG && !fs.existsSync(rG)) {
        fs.mkdirSync(rG); fs.writeFileSync(path.join(rG, 'cpu.cfs_period_us'), '10000'); P.dev.mult.set(rG, CORES);
        fs.writeFileSync(path.join(rG, 'cpu.cfs_quota_us'), P.dev.quotaOn ? String(Math.round(10000 * P.dev.frac * CORES)) : '-1');
        P.dev.rG = rG;
      }
      const g = gpuG || path.join(rG, 't' + t);
      try {
        if (!fs.existsSync(g)) {
          fs.mkdirSync(g);
          fs.writeFileSync(path.join(g, 'cpu.cfs_period_us'), '10000');
          P.dev.mult.set(g, gpuG ? CORES : 1);
          fs.writeFileSync(path.join(g, 'cpu.cfs_quota_us'), P.dev.quotaOn ? String(Math.round(10000 * P.dev.frac * P.dev.mult.get(g))) : '-1');
        }
        fs.writeFileSync(path.join(g, 'tasks'), t);
        P.dev.groups.set(+t, g);
      } catch (e) {}
    }
  }
}
function deviceQuota(P, on) {
  P.dev.quotaOn = on;
  // the shared renderer cap first when raising quotas off, last when turning them on (a child may not exceed its parent)
  const gs = [...new Set(P.dev.groups.values())]; if (P.dev.rG) { if (on) gs.push(P.dev.rG); else gs.unshift(P.dev.rG); }
  for (const g of gs) { try { fs.writeFileSync(path.join(g, 'cpu.cfs_quota_us'), on ? String(Math.round(10000 * P.dev.frac * (P.dev.mult.get(g) || 1))) : '-1'); } catch (e) {} }
}
function deviceStat(P) {
  let thr = 0, nrp = 0, nrt = 0;
  for (const g of new Set(P.dev.groups.values())) {
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
    for (const g of new Set(P.dev.groups.values())) { try { fs.rmdirSync(g); } catch (e) { left++; } }
    if (P.dev.rG) { try { fs.rmdirSync(P.dev.rG); } catch (e) {} }
    try { fs.rmdirSync(P.dev.top); fs.rmdirSync(P.dev.set); return; } catch (e) {}
    await sleep(250);
  }
}

// ---- players ---------------------------------------------------------------------------
async function launch(role, cpus) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mp4r2-${role}-`));
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir, protocolTimeout: 600000,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
           '--js-flags=--max-old-space-size=512', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
           '--window-size=1280,800'] });
  guard.guard(browser, 'gamecube/native/tools/mp4n_toaster_room2.mjs');
  const P = { role, browser, dir, rows: [], lines: [], errs: [] };
  makeDevice(P, cpus);
  deviceScan(P); P.scan = setInterval(() => deviceScan(P), 300);
  P.page = (await browser.pages())[0] || await browser.newPage();
  // SENDTIME=1 (diagnostic): time every RTCDataChannel / WebSocket send on the page (window.__sendT)
  if (process.env.SENDTIME === '1') await P.page.evaluateOnNewDocument(() => {
    const T = window.__sendT = { dc: 0, dcN: 0, dcMax: 0, ws: 0, wsN: 0 };
    const wrap = (proto, k, kn) => { const f = proto.send; proto.send = function () { const t0 = performance.now(); try { return f.apply(this, arguments); } finally { const d = performance.now() - t0; T[k] += d; T[kn]++; if (k === 'dc' && d > T.dcMax) T.dcMax = d; if (k === 'dc') { const L = 'lab_' + this.label; T[L] = (T[L] || 0) + d; T[L + 'N'] = (T[L + 'N'] || 0) + 1; } } }; };
    if (window.RTCDataChannel) wrap(RTCDataChannel.prototype, 'dc', 'dcN');
    if (window.WebSocket) wrap(WebSocket.prototype, 'ws', 'wsN');
  });
  P.page.on('pageerror', (e) => P.errs.push(String(e.message).slice(0, 200)));
  P.tail = [];
  P.page.on('console', (m) => { const t = m.text(); P.tail.push(`${ts()} ${t.slice(0, 300)}`); if (P.tail.length > 400) P.tail.shift();
    if (/ARMED|armed|desync|delay lockstep|zero-lag|capacity|room:|⚠/i.test(t) && P.lines.length < 200) { const L = `${ts()} ${role} ${t.slice(0, 220)}`; P.lines.push(L); console.log('  ' + L); } });
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
const RASTER_SRC = `function computeRasterIndex(duration){
const c=document.createElement('canvas');c.width=640;c.height=480;const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:false});if(!gl)return null;
const sh=(t,src)=>{const s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);return s;};
const p=gl.createProgram();
gl.attachShader(p,sh(gl.VERTEX_SHADER,'#version 300 es\\nvoid main(){vec2 v=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(v*2.0-1.0,0.0,1.0);}'));
gl.attachShader(p,sh(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;uniform float k;out vec4 o;void main(){vec2 q=gl_FragCoord.xy*0.01+k;float a=0.0;for(int i=0;i<48;i++){q=vec2(q.x*q.y+0.13,q.y-q.x*0.71);a+=fract(q.x+q.y);q=fract(q);}o=vec4(a*0.02,q,1.0);}'));
gl.linkProgram(p);gl.useProgram(p);const u=gl.getUniformLocation(p,'k');const px=new Uint8Array(4);
const t0=performance.now();let n=0;while(performance.now()-t0<duration){gl.uniform1f(u,n*0.001);gl.drawArrays(gl.TRIANGLES,0,3);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);n++;}
const r=Math.round(n*10000/(performance.now()-t0));const l=gl.getExtension('WEBGL_lose_context');if(l)l.loseContext();return r;}`;
const rasterRun = (P) => P.page.evaluate(`(${RASTER_SRC})(2000)`);
const benchRun = (P, ms) => P.page.evaluate((ms) => new Promise((r) => { window.__bw.onmessage = (e) => r(e.data); window.__bw.postMessage(ms); }), ms);
async function proof(PS) {
  const med = (v) => v.slice().sort((x, y) => x - y)[Math.floor(v.length / 2)];
  const R = {};
  for (const P of PS) await benchWorker(P);
  for (const P of PS) { deviceQuota(P, false); const v = []; for (let i = 0; i < 5; i++) v.push(await benchRun(P, 2000)); R[P.role] = { free: med(v) };
    const rv = []; for (let i = 0; i < 3; i++) rv.push(await rasterRun(P)); R[P.role].rasterFree = med(rv); }
  for (const P of PS) deviceQuota(P, true);
  await sleep(300);
  for (const P of PS) { const v = []; for (let i = 0; i < 3; i++) v.push(await benchRun(P, 2000)); R[P.role].alone = med(v);
    const rv = []; for (let i = 0; i < 3; i++) rv.push(await rasterRun(P)); R[P.role].rasterAlone = med(rv); }
  if (PS.length > 1) {
    const tog = await Promise.all(PS.map(async (P) => { const v = []; for (let i = 0; i < 3; i++) v.push(await benchRun(P, 2000)); return med(v); }));
    PS.forEach((P, i) => { R[P.role].together = tog[i]; });
  }
  for (const P of PS) {
    const r = R[P.role];
    r.slowdown = +(r.free / r.alone).toFixed(2);
    r.rasterSlowdown = r.rasterFree && r.rasterAlone ? +(r.rasterFree / r.rasterAlone).toFixed(2) : null;
    if (r.together != null) r.share = +(r.together / r.alone).toFixed(3);
    r.cpuset = cpusetProof(P); r.cg = deviceStat(P);
    say(`PROOF ${P.role}: BenchmarkIndex free ${r.free} alone ${r.alone} together ${r.together ?? '-'} -> slowdown ${r.slowdown}x (want ~${rate}), share ${r.share ?? '-'} (want ~1), cpus ${JSON.stringify(r.cpuset)}, throttled ${r.cg.nr_throttled}/${r.cg.nr_periods} periods; raster free ${r.rasterFree} quota ${r.rasterAlone} -> ${r.rasterSlowdown}x (GPU ${GPUOFF ? 'NOT throttled, --gpuoff' : 'throttled, want >= ' + (0.5 * rate).toFixed(1)})`);
    r.ok = Math.abs(r.slowdown / rate - 1) <= 0.25 && (r.share == null || r.share >= 0.9) && Object.keys(r.cpuset).length === 1 && r.cg.nr_throttled > 0 && (GPUOFF || (r.rasterSlowdown != null && r.rasterSlowdown >= 0.5 * rate));
  }
  return R;
}

// ---- run -------------------------------------------------------------------------------
const probe = () => {
  const t = performance.now();
  if (window.Mp4Room) {
    const m = window.__mp4n && window.__mp4n.module, r = window.Mp4Room.report(), e = r.engine || {};
    const room = r.armed;
    const frame = room ? r.stats.live : (m ? m._mp4web_total() : null);
    return { t, frame, pres: m && m._mp4web_drawn ? m._mp4web_drawn() : (room ? r.stats.live - r.stats.hidden : frame), hz: 60, state: room ? e.state : (frame > 0 ? 'running' : null),
             stalls: r.stats.holds, rb: e.rollback, delay: e.delay, desync: !!e.desync, hc: e.hashesCompared, rollbacks: r.stats.rollbacks,
             busy: m ? m._mp4web_busy_ms() : null, total: m ? m._mp4web_total() : null, st: r.stats,
             rbw: e.rb ? { window: e.rb.window, meanDepth: e.rb.meanDepth, maxDepth: e.rb.maxDepth, rollbacks: e.rb.rollbacks, resimFrames: e.rb.resimFrames, predicted: e.rb.predictedFrames, catchUps: e.rb.catchUps } : null, mode: e.rollback ? 'rollback' : (e.delay != null ? 'delay' : null) };
  }
  const g = window.__gcLockstep ? window.__gcLockstep() : null, R = window.__gcRate || {};
  const room = !!(g && g.gated);
  let ps = null; try { ps = window.__gcPresentStats ? window.__gcPresentStats() : null; } catch (e) {}
  // pictures/s as lib/bench.js's gamecube adapter reads them: what reached the canvas where the page counts
  // it (shown), else what the renderer acknowledged (ackedPerS), else what it published
  return { t, frame: g ? g.guestFrames : null, pres: ps && ps.captured > 0 ? ps.captured : null, presRate: R.shown > 0 ? R.shown : (R.ackedPerS != null ? R.ackedPerS : R.published), hz: 60, state: room ? g.state : (g && g.guestFrames > 0 ? 'running' : null),
           stalls: g ? g.bfStall : null, rb: g && g.mode === 'rollback' ? 8 : 0, delay: g ? g.delay : null, desync: !!(g && g.state === 'desync'),
           hc: null, rollbacks: g && g.rollback ? g.rollback.rollbacks : null, speed: R.speed };
};
let broker = null; const PS = [];
try {
  const cpusFor = (i) => `${i * CORES}-${i * CORES + CORES - 1}`;
  const roles = mode === 'solo' ? ['A'] : ['H', 'J'];
  for (let i = 0; i < roles.length; i++) PS.push(await launch(roles[i], cpusFor(i)));
  if (!NOPROOF) { out.proof = await proof(PS); out.proofOk = Object.values(out.proof).every((r) => r.ok); if (!out.proofOk) say('PROOF FAILED — the run is VOID'); }
  for (const P of PS) deviceQuota(P, true);
  if (mode === 'room') {
    const { startBroker } = await import(pathToFileURL(path.join(ROOT, 'tools', 'mqtt_ws_broker.mjs')).href);
    broker = await startBroker({ port: 0 });
    const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
    const sig = '&signal=ws&wsbroker=' + encodeURIComponent(broker.url);
    const url = (role) => BASE + (PAGE === 'native' ? '/mp4-native.html?players=2&np=' : '/gamecube.html?np=') + code + '&game=' + encodeURIComponent('Mario Party 4') + (role === 'H' ? '' : '&join=1') + sig + extra;
    await PS[0].page.goto(url('H'), { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await PS[1].page.goto(url('J'), { waitUntil: 'domcontentloaded' });
    out.urls = { H: url('H'), J: url('J') };
  } else {
    for (const P of PS) {
      if (PAGE === 'native') await P.page.goto(`${BASE}/mp4-native.html?autostart=1&nosave=1${extra}`, { waitUntil: 'load', timeout: 180000 });
      else { await P.page.evaluateOnNewDocument(() => { try { localStorage.setItem('gcwasm_romIdx', '0'); } catch (e) {} });
             await P.page.goto(`${BASE}/gamecube.html?${extra.replace(/^&/, '')}`, { waitUntil: 'load', timeout: 180000 });
             await sleep(3000); await P.page.evaluate(() => { const b = document.getElementById('btnStart'); if (b && !b.disabled) b.click(); }).catch(() => {}); }
    }
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
      r.T = ts(); P.rows.push(r);
      {
        const run = (x) => x && x.frame > 30 && (x.state === 'running' || x.state === 'stalled');
        if (P.t0 == null && run(r)) P.t0 = r.T;
        const prev = P.rows[P.rows.length - 2];
        if (prev && prev.frame != null && r.frame != null) { const dt = (r.t - prev.t) / 1000; r.x = (r.frame - prev.frame) / dt / r.hz;
          r.p = r.pres != null && prev.pres != null ? (r.pres - prev.pres) / dt : (r.presRate != null ? r.presRate : null);
          r.ms = r.busy != null && prev.busy != null && r.total > prev.total ? (r.busy - prev.busy) / (r.total - prev.total) : null; }
        console.log(`${r.T} ${P.role} f=${r.frame} x=${r.x != null ? r.x.toFixed(3) : '-'} pres=${r.p != null ? r.p.toFixed(1) : '-'}/s ${r.state} ${r.rb ? 'RB' : 'd' + r.delay} stalls=${r.stalls} rbk=${r.rollbacks} hc=${r.hc}${r.desync ? ' DESYNC' : ''}`);
        // PROFILE=role: a CPU profile of that console for PROFILE_S seconds, from SKIP s after it opens
        // (a profile perturbs timing: use it for where the CPU goes, never for a rate)
        if (process.env.PROFILE === P.role && P.t0 != null && !P.prof && r.T - P.t0 >= SKIP) {
          P.prof = (async () => { const c = await P.page.target().createCDPSession(); await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 200 }); await c.send('Profiler.start');
            await sleep(1000 * +(process.env.PROFILE_S || 20)); const { profile } = await c.send('Profiler.stop');
            fs.writeFileSync(`${OUTD}/${name}-${P.role}.cpuprofile`, JSON.stringify(profile)); say(`profile -> ${OUTD}/${name}-${P.role}.cpuprofile`); })().catch((e) => say('profile failed ' + e));
        }
        // TRACE=role: a Chrome trace (every process: renderer threads, GPU process, GC, uploads) while that
        // console's guest frame is in [TRACE_FROM, TRACE_TO) (default 600..950: the boot's title load)
        if (process.env.TRACE === P.role && !P.trace && r.frame != null && r.frame >= +(process.env.TRACE_FROM || 600)) {
          P.trace = (async () => {
            const cats = (process.env.TRACE_CATS || 'devtools.timeline,disabled-by-default-devtools.timeline,v8,v8.gc,disabled-by-default-v8.gc,toplevel,gpu,blink,webaudio,audio,disabled-by-default-devtools.timeline.frame,cc,viz,scheduler').split(',');
            await P.page.tracing.start({ path: `${OUTD}/${name}-${P.role}.trace.json`, categories: cats });
            say(`trace on at f=${r.frame}`);
            const until = +(process.env.TRACE_TO || 950), t1 = Date.now() + 20000;
            while (Date.now() < t1) { await sleep(250); const last = P.rows[P.rows.length - 1]; if (last && last.frame >= until) break; }
            await P.page.tracing.stop(); say(`trace -> ${OUTD}/${name}-${P.role}.trace.json`);
          })().catch((e) => say('trace failed ' + e));
        }
        if (P.t0 != null && !P.cpu0 && r.T - P.t0 >= SKIP) P.cpu0 = { c: cpuByType(P), f: r.frame, T: r.T };
        if (P.cpu0 && !P.cpu1 && r.T - P.t0 >= SKIP + secs) P.cpu1 = { c: cpuByType(P), f: r.frame, T: r.T };
        if (P.t0 == null || r.T - P.t0 < SKIP + secs) done = false;
      }
    }
    if (done) break;
  }
  for (const P of PS) if (P.prof) await P.prof;
  const mean = (v) => v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  for (const P of PS) {
    const R = P.rows, w = P.t0 == null ? [] : R.filter((r) => r.T > P.t0 + SKIP && r.T <= P.t0 + SKIP + secs && r.x != null);
    const steady = w.slice(Math.floor(w.length / 2)), last = R[R.length - 1] || {}, first = w[0] || {};
    const o = out.players[P.role] = { openT: P.t0, skip: SKIP, win: { n: w.length, x: mean(w.map((r) => r.x)), min: w.length ? Math.min(...w.map((r) => r.x)) : null, presented: mean(w.map((r) => r.p).filter((v) => v != null)), msPerFrame: mean(w.map((r) => r.ms).filter((v) => v != null)) },
      steady: { n: steady.length, x: mean(steady.map((r) => r.x)) },
      stalls: last.stalls != null && first.stalls != null ? last.stalls - first.stalls : null, stallMs: last.stallMs != null && first.stallMs != null ? Math.round(last.stallMs - first.stallMs) : null,
      rollbacks: last.rollbacks, desync: last.desync || null, hc: last.hc, cg: deviceStat(P), lines: P.lines, errs: P.errs.slice(0, 8), tail: P.errs.length ? P.tail.slice(-150) : [],
      lastStats: last.st || null, lastRb: last.rbw || null, lastMode: last.mode || null,
      rows: R.map((r) => ({ T: r.T, f: r.frame, x: r.x, st: r.state, rb: r.rb, d: r.delay, stalls: r.stalls })) };
    if (o.lastStats) say(`STATS ${P.role}: ${JSON.stringify(o.lastStats)} rb=${JSON.stringify(o.lastRb)} mode=${o.lastMode}`);
    if (P.cpu0 && P.cpu1) { const fr = Math.max(1, P.cpu1.f - P.cpu0.f), sec = P.cpu1.T - P.cpu0.T, by = {};
      for (const [pid, v] of Object.entries(P.cpu1.c)) by[v.k] = (by[v.k] || 0) + 1000 * (v.t - ((P.cpu0.c[pid] || {}).t || 0)) / fr;
      for (const k of Object.keys(by)) by[k] = +by[k].toFixed(2);
      o.cpuMsPerFrame = by; say(`CPU ${P.role}: ms per guest frame by process ${JSON.stringify(by)} over ${fr} frames / ${sec.toFixed(0)} s`); }
    if (process.env.SENDTIME === '1') { try { say(`SENDTIME ${P.role}: ${JSON.stringify(await P.page.evaluate(() => window.__sendT))}`); } catch (e) {} }
    say(`SUMMARY ${PAGE} ${mode} ${P.role}: open@${o.openT}s window x=${o.win.x && o.win.x.toFixed(3)} min ${o.win.min && o.win.min.toFixed(3)} presented ${o.win.presented != null ? o.win.presented.toFixed(1) : '-'}/s host ${o.win.msPerFrame != null ? o.win.msPerFrame.toFixed(1) : '-'} ms/frame (n=${o.win.n}, first ${SKIP}s discarded)  steady x=${o.steady.x && o.steady.x.toFixed(3)}  stalls ${o.stalls}  desync=${o.desync} hc=${o.hc}  throttled ${o.cg.nr_throttled}/${o.cg.nr_periods}`);
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
