// perf_browser.mjs — THROUGHPUT of statically recompiled SAB code, measured IN CHROME.
//
//   SR_OUT=/tmp/sr_wi_o2 node gamecube/recomp/sr/perf_browser.mjs <fixture.json> [more.json ...]
//
// Env: SR_OUT (dir holding sr_slice.{js,wasm}, built with SR_ENV=web,worker),
//      PERF_REPS (default 20000), PERF_TRIALS (default 7), PERF_HEADLESS=0 to watch.
//
// WHY A BROWSER AND NOT NODE. The number this produces is meant to be read next to
// the JIT emulator's guest rate, and that rate is only ever measured in Chrome
// (gamecube/tools/dolphin_render_probe.js). Node and Chrome ship different V8
// versions and different wasm tier-up behaviour, and this module is ~22 MB, which is
// exactly the regime where those differ. Measuring the two engines in two different
// runtimes would be an unmatched pair (CLAUDE.md gate #10).
//
// WHAT THIS MEASURES, stated before the number so it cannot be quoted loose:
//   * Real SAB functions, translated from the SHIPPED BINARY by sr.py, executing
//     inside the WHOLE-IMAGE module (every translated function in main.dol present),
//     replayed from entry states captured off native Dolphin's reference interpreter
//     and already verified bit-exact by verify_fixture.mjs / verify_slice.mjs.
//   * Guest state and every byte the function WRITES are restored before each
//     invocation. That restore is measured in a matched empty-body control and
//     SUBTRACTED; both raw and corrected figures are printed.
//   * It is NOT a whole-system rate. There is no interrupt delivery, no DMA, no GPU,
//     no audio, no OS scheduling, and no cache pressure from the rest of the game.
//     The JIT's guest rate includes all of those, so this number is OPTIMISTIC
//     against it. Say "translated-code throughput", never "the game runs at N".
//
// The run ABORTS a fixture if any invocation faults, so an early-exiting function
// cannot be mistaken for a fast one.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';

const SLICE = process.env.SR_OUT || '/tmp/sr_slice';
const REPS = Number(process.env.PERF_REPS || 20000);
const TRIALS = Number(process.env.PERF_TRIALS || 7);
const HEADLESS = process.env.PERF_HEADLESS !== '0';
const GEKKO_HZ = 486_000_000;

// ---------------------------------------------------------------- exact JSON
// Identical to verify_fixture.mjs: a JS Number cannot hold a 64-bit FPR pattern and
// plain JSON.parse silently rounds it. perf_fixture.mjs still uses the lossy reader;
// for a PERF run a rounded FPR can steer a branch, so read exactly here too.
const SOURCE_REVIVER_OK = (() => {
  try {
    return JSON.parse('{"a":4550999638074826707}',
      (k, v, ctx) => (ctx && ctx.source) ? ctx.source : v).a === '4550999638074826707';
  } catch { return false; }
})();
function parseExact(text) {
  if (!SOURCE_REVIVER_OK)
    throw new Error(`this Node (${process.version}) has no JSON source reviver; Node 21+ required`);
  return JSON.parse(text, function (k, v, ctx) {
    if (typeof v === 'number' && ctx && typeof ctx.source === 'string' &&
        /^-?\d+$/.test(ctx.source) && !Number.isSafeInteger(v))
      return BigInt(ctx.source);
    return v;
  });
}

// Fixtures cross into the page as JSON, which has no BigInt. Carry the 64-bit lanes
// as hex strings — the same fix xform_vectors.py already applies at capture time.
function toWire(fx) {
  const si = fx.state_in;
  return {
    entry: Number(fx.entry) >>> 0,
    steps: Number(fx.steps),
    gpr: si.gpr.map((x) => Number(x) >>> 0),
    fprHex: si.fpr.map((x) => BigInt(x).toString(16).padStart(16, '0')),
    cr: Number(si.cr) >>> 0, xer: Number(si.xer) >>> 0, lr: Number(si.lr) >>> 0,
    ctr: Number(si.ctr) >>> 0, fpscr: Number(si.fpscr) >>> 0,
    gqr: (fx.gqr || new Array(8).fill(0)).map((x) => Number(x) >>> 0),
    initial_mem: Object.entries(fx.initial_mem).map(([a, b]) => [parseInt(a, 16) >>> 0, Number(b)]),
    writes: (fx.writes || []).map((w) => [Number(w.ea) >>> 0, String(w.before)]),
  };
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm' };
function startServer(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/' || p === '/index.html') {
        const body = '<!doctype html><meta charset=utf-8><title>sr perf</title><body>';
        res.setHeader('Content-Type', 'text/html');
        res.end(body);
        return;
      }
      const fp = path.join(dir, p);
      fs.stat(fp, (err, st) => {
        if (err) { res.statusCode = 404; res.end('404'); return; }
        res.setHeader('Content-Type', MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Content-Length', st.size);
        fs.createReadStream(fp).pipe(res);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ------------------------------------------------------- runs inside the page
async function measureInPage(page, wire, cfg) {
  return page.evaluate(async (wire, cfg) => {
    const O_GPR = 0, O_PS0 = 128, O_PS1 = 384, O_CR = 640, O_XER = 644, O_LR = 648,
          O_CTR = 652, O_FPSCR = 656, O_GQR = 660, O_PC = 692, SZ = 696;
    const factory = (await import(cfg.moduleUrl)).default;
    const M = await factory();
    if (!M._sr_init()) throw new Error('sr_init failed');
    if (M._sr_state_size() !== SZ)
      throw new Error(`GekkoState size ${M._sr_state_size()} != ${SZ}`);
    const ram = M._sr_ram(), st = M._sr_state();
    const phys = (a) => (a & 0x03ffffff) >>> 0;
    const H = M.HEAPU8;
    const out = [];

    for (const fx of wire) {
      const entry = fx.entry >>> 0;
      const tag = '0x' + entry.toString(16).padStart(8, '0');

      // SPARSE restore set: only bytes the function WRITES can differ between
      // iterations. A contiguous [min,max] snapshot copies megabytes (one fixture
      // stages 84 bytes across a 2.4 MB span) and the restore becomes the whole
      // measurement.
      const pre = new Map();
      for (const [ea, beforeHex] of fx.writes) {
        for (let i = 0; i * 2 < beforeHex.length; i++) {
          const off = phys(ea + i);
          if (!pre.has(off)) pre.set(off, parseInt(beforeHex.substr(i * 2, 2), 16));
        }
      }
      const rOff = new Int32Array(pre.size), rVal = new Uint8Array(pre.size);
      { let i = 0; for (const [o, v] of pre) { rOff[i] = o; rVal[i] = v; i++; } }

      for (const [a, b] of fx.initial_mem) H[ram + phys(a)] = b;

      const stSnap = new Uint8Array(SZ);
      {
        const dv = new DataView(stSnap.buffer);
        for (let i = 0; i < 32; i++) dv.setUint32(O_GPR + i * 4, fx.gpr[i] >>> 0, true);
        for (let i = 0; i < 32; i++) {
          const v = BigInt('0x' + fx.fprHex[i]);
          dv.setBigUint64(O_PS0 + i * 8, v, true);
          dv.setBigUint64(O_PS1 + i * 8, v, true);
        }
        dv.setUint32(O_CR, fx.cr, true);   dv.setUint32(O_XER, fx.xer, true);
        dv.setUint32(O_LR, fx.lr, true);   dv.setUint32(O_CTR, fx.ctr, true);
        dv.setUint32(O_FPSCR, fx.fpscr, true);
        for (let i = 0; i < 8; i++) dv.setUint32(O_GQR + i * 4, fx.gqr[i] >>> 0, true);
        dv.setUint32(O_PC, entry, true);
      }

      const n = rOff.length;
      const restore = () => { H.set(stSnap, st); for (let i = 0; i < n; i++) H[ram + rOff[i]] = rVal[i]; };

      restore();
      const probe = M._sr_call(entry) >>> 0;
      if (probe !== 0) { out.push({ tag, skip: `faults 0x${probe.toString(16)}` }); continue; }

      // MATCHED PAIR, min of TRIALS: identical rep counts for run and control, and
      // the MINIMUM rather than one sample — matched-pair noise on this box has been
      // as bad as +/-25% at load 11-23.
      const runBody = () => { for (let i = 0; i < cfg.reps; i++) { restore(); M._sr_call(entry); } };
      const ctrlBody = () => { for (let i = 0; i < cfg.reps; i++) { restore(); } };
      runBody(); ctrlBody();                       // warm both tiers
      let runMin = Infinity, ctrlMin = Infinity;
      for (let t = 0; t < cfg.trials; t++) {
        let a = performance.now(); runBody(); runMin = Math.min(runMin, performance.now() - a);
        a = performance.now(); ctrlBody(); ctrlMin = Math.min(ctrlMin, performance.now() - a);
      }
      const fault = M._sr_call(entry) >>> 0;
      if (fault !== 0) { out.push({ tag, skip: `faulted mid-benchmark 0x${fault.toString(16)}` }); continue; }

      const perRunMs = runMin / cfg.reps, perCtrlMs = ctrlMin / cfg.reps;
      const netMs = perRunMs - perCtrlMs;
      out.push({
        tag, steps: fx.steps, restoreBytes: n, perRunMs, perCtrlMs, netMs,
        overhead: 100 * perCtrlMs / perRunMs,
        rawIps: fx.steps / (perRunMs / 1000),
        netIps: netMs > 0 ? fx.steps / (netMs / 1000) : null,
      });
    }
    return out;
  }, wire, cfg);
}

const main = async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: perf_browser.mjs <fixture.json> [more...]'); process.exit(2); }

  const wire = [];
  for (const f of files) {
    const j = parseExact(fs.readFileSync(f, 'utf8'));
    for (const fx of j.fixtures) {
      if (fx.usable === false) continue;
      if (fx.outside_mem1 && fx.outside_mem1.length) continue;   // replay stages MEM1 only
      wire.push(toWire(fx));
    }
  }
  const wasm = path.resolve(SLICE, 'sr_slice.wasm');
  console.log(`slice   : ${wasm}  ${fs.statSync(wasm).size} bytes`);
  console.log(`fixtures: ${wire.length} usable from ${files.length} file(s)`);
  console.log(`reps    : ${REPS} x ${TRIALS} trials (min)`);
  console.log('');

  const srv = await startServer(SLICE);
  const port = srv.address().port;
  const SYS_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const launchOpts = {
    headless: HEADLESS ? 'new' : false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 1800000,
  };
  if (fs.existsSync(SYS_CHROME)) launchOpts.executablePath = SYS_CHROME;
  else launchOpts.channel = 'chrome';

  const browser = await puppeteer.launch(launchOpts);
  try { (await import('../../../tools/browser_leak_guard.js')).default.guard(browser, import.meta.url); } catch (_e) {}
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

  let rows;
  try {
    rows = await measureInPage(page, wire, {
      moduleUrl: `http://127.0.0.1:${port}/sr_slice.js`, reps: REPS, trials: TRIALS,
    });
  } finally {
    await browser.close(); srv.close();
  }

  const ok = [];
  for (const r of rows) {
    if (r.skip) { console.log(`SKIP  ${r.tag}  ${r.skip}`); continue; }
    console.log(`${r.tag}  steps=${r.steps}  restore-set=${r.restoreBytes}B`);
    console.log(`   per invocation : ${r.perRunMs.toFixed(6)} ms  (restore control ` +
                `${r.perCtrlMs.toFixed(6)} ms = ${r.overhead.toFixed(1)}% of it, net ${r.netMs.toFixed(6)} ms)`);
    console.log(`   guest instr/s  : ${(r.rawIps / 1e6).toFixed(1)} M raw   ` +
                `${r.netIps ? (r.netIps / 1e6).toFixed(1) : 'n/a'} M restore-corrected`);
    console.log('');
    if (r.netIps && r.overhead < 50) ok.push(r);
  }

  console.log(`fixtures whose restore control is under 50% of the run (the only ones\n` +
              `whose corrected figure is worth reading): ${ok.length} of ${rows.length}`);
  for (const r of ok)
    console.log(`   ${r.tag}  ${(r.netIps / 1e6).toFixed(1)} M instr/s   ` +
                `${(r.netIps / GEKKO_HZ).toFixed(3)} x486MHz-instr-equivalent`);

  if (ok.length) {
    // Aggregate over the usable set, weighting each fixture by the guest instructions
    // it retires — i.e. total guest instructions / total wall time, which is what a
    // mixed workload of these functions would actually deliver. NOT a mean of ratios.
    const instr = ok.reduce((a, r) => a + r.steps, 0);
    const secs = ok.reduce((a, r) => a + r.netMs / 1000, 0);
    console.log('');
    console.log(`AGGREGATE (instruction-weighted over ${ok.length} fixtures): ` +
                `${(instr / secs / 1e6).toFixed(1)} M guest instr/s`);
  }
  console.log('');
  console.log('NOT a whole-system rate — see the header. Restate as translated-code');
  console.log('throughput, never as "the game runs at N".');
};
main();
