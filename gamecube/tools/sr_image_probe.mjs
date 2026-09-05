// sr_image_probe.mjs — drive gamecube/recomp/sr_image/sr_image_boot.html in a REAL
// browser and report how far the statically recompiled SAB image gets.
//
// WHY A BROWSER AND NOT NODE.  Every other harness in gamecube/recomp/sr/ links
// -sENVIRONMENT=node and replays a captured fixture.  The acceptance question here is
// "does the whole image INSTANTIATE AND EXECUTE IN A BROWSER", and node cannot answer
// it: V8's wasm limits, the module-worker loader and the fetch path are all different.
//
// WHAT THIS PROBE CAN AND CANNOT SEE.  sr.py emits straight-line C in which a guest
// `bl` is a host C call, so a running guest cannot be interrupted and this build has no
// -pthread, so there is no shared memory to read mid-call.  The `walk` mode therefore
// exists: it drives __start's own callee sequence one at a time, posting between each,
// so a step that never returns is identified by the LAST 'step-enter' message received
// rather than by a timeout with no information in it.
//
//   node gamecube/tools/sr_image_probe.mjs
//
// env:
//   SRP_MODE=walk|whole    default walk
//   SRP_EXI=0 / SRP_DSP=0  turn ONE device model off — the falsifying control arms
//   SRP_TIMEOUT_MS         default 120000
//   SRP_HEADLESS=0         visible window
//   SRP_PORT               pin the server port (default: OS-assigned ephemeral)
//   SRP_OUT                JSON output path (default /tmp/sr-image-probe.json)
//   SRP_SHOT               screenshot path   (default /tmp/sr-image-probe.png)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = process.env.SRP_ROOT || path.resolve(fileURLToPath(import.meta.url), '../../..');
const MODE = process.env.SRP_MODE || 'walk';
const TIMEOUT = parseInt(process.env.SRP_TIMEOUT_MS || '120000', 10);
const HEADLESS = process.env.SRP_HEADLESS === '0' ? false : 'new';
const OUT = process.env.SRP_OUT || '/tmp/sr-image-probe.json';
const SHOT = process.env.SRP_SHOT || '/tmp/sr-image-probe.png';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wasm': 'application/wasm', '.json': 'application/json',
               '.dol': 'application/octet-stream', '.bin': 'application/octet-stream' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found: ' + rel); return; }
        // Cross-origin isolation is NOT required by this build — it has no -pthread and
        // no SharedArrayBuffer — but the headers are sent anyway so the probe measures
        // the same isolation state the shipped page runs under.
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      });
    });
    srv.listen(parseInt(process.env.SRP_PORT || '0', 10), '127.0.0.1',
               () => resolve({ srv, port: srv.address().port }));
  });
}

const { srv, port } = await serve();
const url = `http://127.0.0.1:${port}/gamecube/recomp/sr_image/sr_image_boot.html`;
console.log('[srp] serving', ROOT, '->', url, ' mode=', MODE);

// Hash-guard: CLAUDE.md gate #10. A concurrent relink has produced torn .js/.wasm pairs
// that fail as "Import #0 env: module is not an object or function", which reads like an
// emulator bug. md5 before AND after.
import { createHash } from 'node:crypto';
const wasmPath = path.join(ROOT, 'gamecube/recomp/sr_image/sab_image.wasm');
const md5 = (p) => { try { return createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
                     catch { return 'MISSING'; } };
const md5Before = md5(wasmPath);
console.log('[srp] wasm md5 before:', md5Before, fs.existsSync(wasmPath) ? fs.statSync(wasmPath).size + ' B' : '');

// The vendored puppeteer has no downloaded browser on this machine
// ("Could not find Chrome (ver. 121.0.6167.85)"), so use the system one — the same
// executablePath gamecube/tools/dolphin_render_probe.js:26 uses.
const CHROME = process.env.SRP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: HEADLESS,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'],
});
const page = await browser.newPage();
const consoleLog = [];
page.on('console', (m) => { const s = `[${m.type()}] ${m.text()}`; consoleLog.push(s); console.log('  ' + s); });
page.on('pageerror', (e) => { const s = `[pageerror] ${e.message}`; consoleLog.push(s); console.log('  ' + s); });
// Name the URL of every failed request. A bare "404 (Not Found)" in the console names
// nothing, and a missing sab_main.dol / sab_fst.bin / sab_image.wasm all read identically.
page.on('requestfailed', (r) => { const s = `[requestfailed] ${r.url()} ${r.failure()?.errorText || ''}`;
                                  consoleLog.push(s); console.log('  ' + s); });
page.on('response', (r) => { if (r.status() >= 400) {
  const s = `[http ${r.status()}] ${r.url()}`; consoleLog.push(s); console.log('  ' + s); } });

await page.goto(url, { waitUntil: 'domcontentloaded' });
// SRP_WALK: guest addresses to walk instead of __start's own callees, separated by
// commas and/or whitespace. See the caveat in sr_image_worker.js — a standalone call is
// a weaker instrument than the default walk.
// Entry syntax: "800e6494", or "800e6494:3=0+4=1+5=3" to stage GPRs before the call,
// which is what makes a standalone call of an EXI routine faithful rather than a call
// with whatever the previous step happened to leave in r3.
const WALK_LIST = (process.env.SRP_WALK || '').split(/[\s,]+/).filter(Boolean)
  .map((s) => {
    const [a, r] = s.split(':');
    const addr = parseInt(a, 16) >>> 0;
    if (!r) return addr;
    const regs = {};
    for (const kv of r.split('+')) { const [k, v] = kv.split('='); regs[+k] = parseInt(v, 16) >>> 0; }
    return [addr, regs];
  });
if (WALK_LIST.length) console.log('[srp] custom walk list:', WALK_LIST.map(
  (e) => Array.isArray(e) ? '0x' + e[0].toString(16) + JSON.stringify(e[1]) : '0x' + e.toString(16)).join(' '));
// Arms. SRP_EXI=0 is the FALSIFYING CONTROL for the EXI zero-latency model: any claim
// that the model unblocked something must reproduce the wedge with it off, on the SAME
// binary and the same md5.
// SRP_OSMODE is the same shape for the GUEST-OS boundary: unset leaves the build in the
// SR_OS_IRQ mode sr_image_init() installs (README §10), so "unset" IS the control arm for
// any claim about the context family, taken on the same binary and the same md5.
//   0 = OFF   1 = HLE   2 = TRACE   3 = IRQ (the build default)   4 = CTX
// SRP_DSP=0 is the same thing for the DSP model, and it is SEPARATE from SRP_EXI because
// the boot cannot reach the DSP at all with EXI off — the arm that matters is EXI on,
// DSP off, which is the state this model's `before` was measured in.
const ARM = { exiModel: process.env.SRP_EXI === '0' ? 0 : 1,
              dspModel: process.env.SRP_DSP === '0' ? 0 : 1,
              watchdog: parseInt(process.env.SRP_WATCHDOG || '0', 10) >>> 0,
              strict: process.env.SRP_STRICT === '1',
              osMode: process.env.SRP_OSMODE === undefined || process.env.SRP_OSMODE === ''
                      ? null : parseInt(process.env.SRP_OSMODE, 10) };
console.log('[srp] arm:', JSON.stringify(ARM));
await page.evaluate((a) => { window.__srImageArm = a; }, ARM);
await page.evaluate((m, w) => window.__srImageRun(m, w), MODE, WALK_LIST.length ? WALK_LIST : null);

// Poll rather than waitForFunction so a run that hangs still reports the last step it
// entered — the whole point of the walk mode.
const t0 = Date.now();
let last = null;
while (Date.now() - t0 < TIMEOUT) {
  const st = await page.evaluate(() => ({
    done: window.__srImage.done,
    error: window.__srImage.error,
    n: window.__srImage.messages.length,
    last: window.__srImage.messages[window.__srImage.messages.length - 1] || null,
  }));
  if (st.n !== (last && last.n)) {
    last = st;
    if (st.last) console.log('[srp] <-', JSON.stringify(st.last).slice(0, 400));
  }
  if (st.done) break;
  await new Promise((r) => setTimeout(r, 250));
}

const result = await page.evaluate(() => ({
  done: window.__srImage.done,
  error: window.__srImage.error,
  messages: window.__srImage.messages,
}));
const elapsed = Date.now() - t0;

await page.screenshot({ path: SHOT, fullPage: true });
const md5After = md5(wasmPath);

const report = {
  url, mode: MODE, elapsedMs: elapsed,
  timedOut: !result.done,
  wasmMd5Before: md5Before, wasmMd5After: md5After,
  wasmIntact: md5Before === md5After,
  lastMessage: result.messages[result.messages.length - 1] || null,
  messages: result.messages,
  pageError: result.error,
  consoleLog,
  screenshot: SHOT,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('\n===== sr_image probe =====');
console.log('mode          :', MODE);
console.log('elapsed       :', elapsed, 'ms', result.done ? '(finished)' : '(TIMED OUT — guest did not return)');
console.log('wasm md5      :', md5Before, md5Before === md5After ? '(intact)' : 'CHANGED -> ' + md5After);
const done = result.messages.find((m) => m.kind === 'done');
const ready = result.messages.find((m) => m.kind === 'ready');
const err = result.messages.find((m) => m.kind === 'error');
if (ready) console.log('instantiated  : YES  entry=' + ready.entry + '  copied=' + ready.copied + 'B  MEM1=' + ready.ramSize);
else       console.log('instantiated  : NO');
if (err) console.log('error         :', err.message);
const stepDone = result.messages.filter((m) => m.kind === 'step-done');
for (const m of stepDone)
  console.log(`  step ${m.addr}  fault=${m.returned} r3=${m.r3} r1=${m.r1}  ${m.ms.toFixed(1)}ms  boundary=${m.logN}`);
const entered = result.messages.filter((m) => m.kind === 'step-enter');
if (!result.done && entered.length) {
  console.log('HUNG IN       :', entered[entered.length - 1].addr, entered[entered.length - 1].what);
  // The per-step log is why a hang still produces evidence: the boundary trajectory up to
  // the LAST COMPLETED step survives even though the hung call never posts a 'done'.
  const lastGood = stepDone[stepDone.length - 1];
  if (lastGood && lastGood.log && lastGood.log.distinct) {
    console.log(`boundary up to the last completed step (${lastGood.addr}): ` +
                `${lastGood.log.total} crossings, ${lastGood.log.distinct.length} distinct`);
    for (const d of lastGood.log.distinct.slice(0, 40))
      console.log(`   ${d.addr}  ${d.disp.padEnd(7)} x${d.n}`);
  }
}
// The device inventory survives a hang the same way the boundary log does: it is posted
// with every completed step, so the last completed step carries it.
const devSrc = done || [...stepDone].reverse().find((m) => m.dev);
if (devSrc && devSrc.dev && devSrc.dev.firstTouch) {
  const d = devSrc.dev;
  console.log(`devices       : ${d.reads} reads / ${d.writes} writes, ${d.exiClears} EXI TSTART clears, ` +
              `${d.dspEvents} DSP-model events, ${d.aramBytes} ARAM DMA bytes, ` +
              `${d.firstTouch.length} distinct registers first-touched`);
  for (const t of d.firstTouch.slice(0, 40)) console.log(`   ${t.addr}  ${t.block.padEnd(7)} ${t.kind}`);
  if (d.dsp) console.log('dsp window    :', Object.entries(d.dsp).map(([k, v]) => k + '=' + v).join(' '));
}
if (done) {
  console.log('fault         :', done.fault);
  if (done.threw) console.log('threw         :', String(done.threw).split('\n')[0]);
  if (done.log && done.log.distinct) {
    console.log(`boundary      : ${done.log.total} crossings, ${done.log.distinct.length} distinct` +
                (done.log.dropped ? `, ${done.log.dropped} DROPPED` : ''));
    for (const d of done.log.distinct.slice(0, 40))
      console.log(`   ${d.addr}  ${d.disp.padEnd(7)} x${d.n}`);
  }
}
console.log('json          :', OUT);
console.log('screenshot    :', SHOT);

await browser.close();
srv.close();
process.exit(0);
