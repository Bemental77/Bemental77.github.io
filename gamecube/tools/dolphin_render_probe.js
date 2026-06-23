// Quick probe: does video_cb ever fire? Boot to first frame.
// Captures all console messages and groups them so we can see what the
// boot pipeline did (or didn't do).
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = 8788;
const TEST_DURATION_MS = parseInt(process.env.PROBE_DURATION_MS || '60000', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Set to truthy (any non-empty value) to capture chrome://tracing JSON +
// page.metrics() snapshots. Default ON because the artifacts are cheap and
// the V8 wasm tier-up signal is not visible from console logs alone.
const CAPTURE_TRACE = process.env.PROBE_NO_TRACE ? false : true;
const TRACE_PATH    = process.env.PROBE_TRACE_PATH || '/tmp/probe-trace.json';
// [worker CPU profile] PROBE_CPU_PROFILE=1 attaches a CDP Profiler to every
// worker target (the CPU loop runs on a PROXY_TO_PTHREAD worker, not main),
// samples during steady-state gameplay, and prints a self-time category
// breakdown (dispatch vs host-imports vs block-bodies vs coretiming) — grounds
// where worker wall-time actually goes instead of the [pc-census] snapshot.
const CPU_PROFILE      = process.env.PROBE_CPU_PROFILE === '1';
const CPU_PROFILE_DELAY = parseInt(process.env.PROBE_CPU_PROFILE_DELAY_MS || '12000', 10);
const CPU_PROFILE_OUT  = process.env.PROBE_CPU_PROFILE_OUT || '/tmp/worker.cpuprofile';
const METRICS_PATH  = process.env.PROBE_METRICS_PATH || '/tmp/probe-metrics.json';
const METRICS_INTERVAL_MS = parseInt(process.env.PROBE_METRICS_INTERVAL_MS || '5000', 10);

// Stuck-pattern early-exit knobs. Build is cheap; we'd rather end the probe
// the instant a recognisable park-pattern shows up than wait the full
// TEST_DURATION_MS for the same answer. Override via env.
const STUCK_DSP_REPEATS        = parseInt(process.env.PROBE_STUCK_DSP_REPEATS || '6', 10);
const STUCK_WILD_IDLE_PER_PC   = parseInt(process.env.PROBE_STUCK_WILD_IDLE_PER_PC || '8', 10);
const STUCK_GRACE_MS           = parseInt(process.env.PROBE_STUCK_GRACE_MS || '3000', 10);
const STUCK_POLL_MS            = parseInt(process.env.PROBE_STUCK_POLL_MS || '250', 10);
// dsp-sentinel-repeat alone is a weak signal — boot has long stretches of
// non-DSP code during which the sentinel naturally repeats. Don't allow it
// to fire until the probe has been running for at least this long.
// wild-idle-detected has no such gate — it's already a strong JIT-confirmed
// signal regardless of elapsed time.
const STUCK_MIN_ELAPSED_MS     = parseInt(process.env.PROBE_STUCK_MIN_ELAPSED_MS || '30000', 10);
const probeStartMs             = Date.now();
let   stuckReason              = null;
let   lastDspSentinel          = null;
let   dspSentinelStreak        = 0;
const wildIdleCount            = Object.create(null);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.bin': 'application/octet-stream', '.iso': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/gamecube.html';
      // Headless gameplay-state injection: serve the PROBE_LOAD_STATE file
      // (a gzipped save-state exported from gamecube.html) at a fixed route so
      // the page can fetch + restore it without a giant page.evaluate arg.
      if (urlPath === '/__probe_state' && process.env.PROBE_LOAD_STATE) {
        const sp = process.env.PROBE_LOAD_STATE;
        fs.stat(sp, (e, st) => {
          if (e) { res.statusCode = 404; res.end('no state'); return; }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', st.size);
          fs.createReadStream(sp).pipe(res);
        });
        return;
      }
      const filePath = path.join(ROOT, urlPath);
      fs.stat(filePath, (err, stat) => {
        if (err) { res.statusCode = 404; res.end('404'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('error', () => { res.statusCode = 500; res.end('err'); });
      });
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await startServer();
  console.log('[probe] server up on :' + PORT);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    // Persistent profile so IndexedDB savestates (SAVE_KEY) survive across runs —
    // lets the slow PSO boot be checkpointed and resumed (PROBE_LOAD_IDB_MS).
    ...(process.env.PROBE_PROFILE_DIR ? { userDataDir: process.env.PROBE_PROFILE_DIR } : {}),
    // V8 flag default = `--no-liftoff` (TurboFan-only). On the post-
    // gate JIT (lever-2 + andc + HLE-check inline), this measured 2.2x
    // throughput vs default V8 (Liftoff baseline + dynamic-tiering)
    // on real-game SAB. Override via PROBE_JS_FLAGS env var.
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
           `--js-flags=--max-old-space-size=4096 ${process.env.PROBE_JS_FLAGS || '--no-liftoff'}`,
           // [cache-bust] disable Chrome's HTTP cache so pthread WORKERS (which
           // fetch dolphin_worker.js / emcc.js / .wasm by bare name, outside the
           // page's setCacheEnabled scope) always load the freshly-linked build.
           // Otherwise new bridge code silently never runs on the proxy-main pthread.
           '--disk-cache-size=1', '--disable-application-cache', '--disable-back-forward-cache',
           '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
  });
  const page = await browser.newPage();

  const buckets = {
    worker: [],
    ipl: [],
    config: [],
    render: [],
    video_cb: [],
    bridge: [],
    jit_first: [],
    jit_heartbeat_count: 0,
    jit_heartbeat_lines: [],
    bemental_predispatch: [],
    bemental_traps: [],
    slice: [],
    vec_dump: [],
    panic_entry: [],
    wild_jump: [],
    page_err: [],
    other: [],
  };

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('video_cb')) buckets.video_cb.push(t);
    else if (t.includes('first frame received') || t.includes('[render]')) buckets.render.push(t);
    else if (t.includes('pre-dispatch') || t.includes('pre-region-dispatch')) buckets.bemental_predispatch.push(t);
    else if (t.includes('dispatch trap') || t.includes('region') && t.includes('trap') || t.includes('chain trap')) buckets.bemental_traps.push(t);
    else if (t.includes('[slice]')) buckets.slice.push(t);
    else if (t.includes('[vec-dump]')) buckets.vec_dump.push(t);
    else if (t.includes('[panic3-entry]') || t.includes('[panic3-')) buckets.panic_entry.push(t);
    else if (t.includes('[wild]') || t.includes('[wild-')) buckets.wild_jump.push(t);
    else if (t.startsWith('[worker]') || t.includes('[worker]')) buckets.worker.push(t);
    else if (t.startsWith('[ipl]') || t.includes('[ipl]')) buckets.ipl.push(t);
    else if (t.startsWith('[config]') || t.includes('[config]')) buckets.config.push(t);
    else if (t.includes('[bridge]')) buckets.bridge.push(t);
    else if (t.includes('[jit] FIRST')) buckets.jit_first.push(t);
    else if (t.includes('[jit] N=')) { buckets.jit_heartbeat_count++; buckets.jit_heartbeat_lines.push(t); }
    else if (t.includes('diag-page-read') || t.includes('shim-poll')
             || t.includes('shim-mem-verify') || t.includes('pthread-load')
             || t.includes('pthread-postload') || t.includes('pthread-shim')
             || t.includes('dolphin-sab-read') || t.includes('dolphin-ppc-state-addr')) {
      buckets.mem_diag = buckets.mem_diag || [];
      buckets.mem_diag.push(t);
    }
    else if (t.includes('mbx-13-fail') || t.includes('mbx-13-ok')
             || t.includes('perf-measurement') || t.includes('perf-result')
             || t.includes('dolphin-compile-test') || t.includes('ppc-worker-diag')
             || t.includes('gri-') || t.includes('ram-info')
             || t.includes('MEM1 wired') || t.includes('update-mem')) {
      buckets.perf_flow = buckets.perf_flow || [];
      buckets.perf_flow.push(t);
    }
    else if (t.includes('[wtraj]')) {
      buckets.wtraj = buckets.wtraj || [];
      buckets.wtraj.push(t);
    }
    else if (t.includes('[mmio-r]') || t.includes('[mmio-w]')) {
      buckets.mmio_trace = buckets.mmio_trace || [];
      buckets.mmio_trace.push(t);
    }
    else buckets.other.push(t);

    // ---- stuck-pattern early-exit detection ------------------------------
    // Build is cheap, probe is the long tail. End the probe as soon as
    // we've detected the run is parked.
    //
    // Signals:
    //   (a) STUCK_DSP_REPEATS+ consecutive identical [dsp-sentinel] lines —
    //       boot has stopped advancing DSP state machine. Weak signal: gated
    //       by STUCK_MIN_ELAPSED_MS because boot has long non-DSP stretches
    //       during which the sentinel naturally repeats.
    //   (b) STUCK_WILD_IDLE_PER_PC+ [wild-idle-detected] events on the same
    //       PC — JIT confirmed the same polling loop is spinning with no
    //       progress. Strong signal: no elapsed-time gate. Takes precedence
    //       over (a) when both fire.
    if (t.indexOf('[dsp-sentinel]') === 0 || t.indexOf('  [dsp-sentinel]') === 0) {
      // Only treat repeats as "stuck" once boot has actually advanced —
      // dsp-sentinel prints on a timer from the very start, so the all-zero
      // pre-boot state would otherwise repeat forever and trip the detector
      // before the JIT even runs.
      const hasActivity = /\bA=([1-9]\d*|0x[1-9a-fA-F])|B=([1-9]\d*)|C=([1-9]\d*)|D=([1-9]\d*)/.test(t)
                          || /lastDSPCR=0x[1-9a-fA-F]/.test(t);
      if (hasActivity) {
        if (lastDspSentinel === t) {
          dspSentinelStreak++;
          const elapsedMs = Date.now() - probeStartMs;
          if (dspSentinelStreak >= STUCK_DSP_REPEATS
              && elapsedMs >= STUCK_MIN_ELAPSED_MS
              && !stuckReason) {
            stuckReason = 'dsp-sentinel-repeat: ' + t.trim();
          }
        } else {
          lastDspSentinel = t;
          dspSentinelStreak = 1;
        }
      }
    }
    const wildIdleMatch = t.match(/\[wild-idle-detected\]\s+pc=(0x[0-9a-fA-F]+)/);
    if (wildIdleMatch) {
      const pc = wildIdleMatch[1];
      wildIdleCount[pc] = (wildIdleCount[pc] || 0) + 1;
      if (wildIdleCount[pc] >= STUCK_WILD_IDLE_PER_PC) {
        // wild-idle is the stronger signal — always overwrite a prior
        // dsp-sentinel-repeat reason for clarity. Don't overwrite an
        // existing wild-idle reason (preserve the first triggering PC).
        if (!stuckReason || stuckReason.indexOf('dsp-sentinel-repeat') === 0) {
          stuckReason = 'wild-idle ' + pc + ' x' + wildIdleCount[pc];
        }
      }
    }
  });
  page.on('pageerror', (err) => buckets.page_err.push(err && err.stack ? err.stack : (err && err.message ? err.message : String(err))));

  await page.setCacheEnabled(false);
  const _extra = process.env.PROBE_QUERY ? ('&' + process.env.PROBE_QUERY) : '';
  await page.goto(`http://127.0.0.1:${PORT}/gamecube.html?v=${Date.now()}${_extra}`, { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1000));
  // ROM_IDX selects gamecube.html ROMS[] by index (verified live 2026-06-14):
  //   0 = Mario Party 4, 1 = Sonic Adventure 2 Battle,
  //   2 = Phantasy Star Online Ep I&II Plus (PSO), 3 = 240pSuite (homebrew).
  // (The old "0=SAB,1=PSO" note predated the MP4 + 240pSuite additions.)
  const romIdx = parseInt(process.env.ROM_IDX || '0', 10);
  await page.evaluate((idx) => {
    localStorage.setItem('gcwasm_romIdx', String(idx));
    const sel = document.getElementById('romSelect');
    if (sel) sel.value = String(idx);
  }, romIdx);
  console.log('[probe] selected ROM index ' + romIdx);

  // ---- chrome://tracing capture ------------------------------------------
  // Categories needed for V8 WASM tier-up confirmation (Liftoff→TurboFan):
  //   - disabled-by-default-v8.compile      → wasm.CompileCode events
  //   - disabled-by-default-v8.wasm.detailed → wasm.OptimizeCode events
  //   - v8 / v8.execute                      → JS execution context
  //   - devtools.timeline                    → frame timing, layout, GPU
  // Output is a chrome://tracing-format JSON the user can load directly,
  // or we can grep for the wasm.* events to count tier-up promotions.
  if (CAPTURE_TRACE) {
    try {
      await page.tracing.start({
        path: TRACE_PATH,
        categories: [
          'v8',
          'v8.execute',
          'disabled-by-default-v8.compile',
          'disabled-by-default-v8.wasm.detailed',
          'devtools.timeline',
        ],
      });
      console.log('[probe] tracing started → ' + TRACE_PATH);
    } catch (e) {
      console.error('[probe] tracing.start failed: ' + e.message);
    }
  }

  const picked = await page.evaluate(() => {
    const sel = document.getElementById('romSelect');
    const b = document.getElementById('btnStart');
    if (b) b.click();
    return sel && sel.options[+sel.value] ? sel.options[+sel.value].textContent : 'unknown';
  });
  console.log('[probe] Start clicked (ROM=' + picked + '), observing for ' + (TEST_DURATION_MS/1000) + 's...');

  // ---- worker CPU profiler (PROBE_CPU_PROFILE=1) --------------------------
  const cpuProf = { sessions: [], started: false };
  if (CPU_PROFILE) {
    setTimeout(async () => {
      try {
        const wts = browser.targets().filter(
          (t) => ['worker', 'shared_worker', 'other'].includes(t.type()));
        for (const t of wts) {
          try {
            const s = await t.createCDPSession();
            await s.send('Profiler.enable');
            await s.send('Profiler.setSamplingInterval', { interval: 200 });
            await s.send('Profiler.start');
            cpuProf.sessions.push({ url: t.url(), type: t.type(), s });
          } catch (_e) { /* not profilable */ }
        }
        cpuProf.started = true;
        console.log('[probe] CPU profiler started on ' + cpuProf.sessions.length
          + ' worker target(s) after ' + CPU_PROFILE_DELAY + 'ms boot-skip');
      } catch (e) { console.error('[probe] CPU profiler start failed: ' + e.message); }
    }, CPU_PROFILE_DELAY);
  }

  // ---- synthetic pad presses ----------------------------------------------
  // PROBE_PRESS="start@45000,a@52000" → at each offset (ms from Start
  // click), hold the named GC button for PRESS_HOLD_MS via the page's own
  // dispatchKey path (same route the touch controls use), so the press
  // flows pad-buffer → 10ms input pump → worker g_pad → input_state_cb.
  const PRESS_HOLD_MS = 500;
  const PRESS_KEY = { start: 'v', select: 'c', a: 'x', b: 'z', x: 's', y: 'd', l: 'w', r: 'r', z: 'e', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  (process.env.PROBE_PRESS || '').split(',').filter(Boolean).forEach((spec) => {
    const m = spec.trim().match(/^(\w+)@(\d+)$/);
    if (!m || !PRESS_KEY[m[1]]) { console.log('[probe] PROBE_PRESS spec ignored: ' + spec); return; }
    const key = PRESS_KEY[m[1]];
    // page.keyboard emits TRUSTED events — exercises the real
    // physical-keyboard path in gamecube.html (keydown/keyup listeners
    // → mobilePadState → updatePadState → 10ms input pump).
    setTimeout(async () => {
      try {
        await page.keyboard.down(key);
        console.log('[probe] press ' + m[1] + ' down @' + m[2] + 'ms');
        setTimeout(async () => {
          try { await page.keyboard.up(key); console.log('[probe] press ' + m[1] + ' up'); }
          catch (e) { console.log('[probe] press keyup failed: ' + e.message); }
        }, PRESS_HOLD_MS);
      } catch (e) { console.log('[probe] press keydown failed: ' + e.message); }
    }, parseInt(m[2], 10));
  });

  // ---- gameplay-state injection (skip the boot) ---------------------------
  // PROBE_LOAD_STATE=<path to gzipped state exported from gamecube.html>.
  // After PROBE_LOAD_STATE_MS (default 25000ms post-Start, enough for the core
  // to finish retro_load_game), fetch /__probe_state and restore it so the
  // probe measures GAMEPLAY rather than the boot decompressor.
  if (process.env.PROBE_LOAD_STATE) {
    const loadAt = parseInt(process.env.PROBE_LOAD_STATE_MS || '25000', 10);
    setTimeout(async () => {
      try {
        const r = await page.evaluate(async () => {
          if (typeof window.__probeLoadStateFromGz !== 'function') return 'no-hook';
          const resp = await fetch('/__probe_state', { cache: 'no-store' });
          if (!resp.ok) return 'fetch-' + resp.status;
          const buf = new Uint8Array(await resp.arrayBuffer());
          await window.__probeLoadStateFromGz(buf);
          return 'loaded ' + buf.byteLength + ' bytes';
        });
        console.log('[probe] PROBE_LOAD_STATE @' + loadAt + 'ms -> ' + r);
      } catch (e) { console.log('[probe] PROBE_LOAD_STATE failed: ' + e.message); }
    }, loadAt);
  }

  // ---- screenshot capture (verify what's actually on screen) --------------
  // PROBE_SHOT="/tmp/x.png@50000" → CDP compositor screenshot at that offset.
  // Captures the composited page incl. the worker-owned OffscreenCanvas, which
  // main-thread getImageData cannot reach.
  (process.env.PROBE_SHOT || '').split(',').filter(Boolean).forEach((spec) => {
    const m = spec.trim().match(/^(.+)@(\d+)$/);
    if (!m) { console.log('[probe] PROBE_SHOT spec ignored: ' + spec); return; }
    setTimeout(async () => {
      try { await page.screenshot({ path: m[1], captureBeyondViewport: false }); console.log('[probe] screenshot -> ' + m[1] + ' @' + m[2] + 'ms'); }
      catch (e) { console.log('[probe] screenshot failed: ' + e.message); }
    }, parseInt(m[2], 10));
  });

  // ---- report the WASM build's own raw DoState size (format-compat check) --
  if (process.env.PROBE_STATE_SIZE_MS) {
    setTimeout(async () => {
      try {
        const sz = await page.evaluate(() => window.__probeStateSize ? window.__probeStateSize() : -1);
        console.log('[probe] WASM raw DoState size = ' + sz + ' bytes');
      } catch (e) { console.log('[probe] state-size check failed: ' + e.message); }
    }, parseInt(process.env.PROBE_STATE_SIZE_MS, 10));
  }

  // ---- checkpoint: resume the slow boot from IndexedDB ---------------------
  // PROBE_LOAD_IDB_MS=<ms>: restore the saved checkpoint (SAVE_KEY) so the run
  // continues from where a prior run left off (needs PROBE_PROFILE_DIR).
  if (process.env.PROBE_LOAD_IDB_MS) {
    setTimeout(async () => {
      try {
        const r = await page.evaluate(async () => {
          if (!window.__probeHasState || !(await window.__probeHasState())) return 'no-checkpoint';
          await window.__probeLoadState(); return 'resumed';
        });
        console.log('[probe] PROBE_LOAD_IDB @' + process.env.PROBE_LOAD_IDB_MS + 'ms -> ' + r);
      } catch (e) { console.log('[probe] PROBE_LOAD_IDB failed: ' + e.message); }
    }, parseInt(process.env.PROBE_LOAD_IDB_MS, 10));
  }

  // PROBE_SAVE_AT_MS=<ms>[,<ms>...]: checkpoint to IndexedDB at each offset.
  (process.env.PROBE_SAVE_AT_MS || '').split(',').filter(Boolean).forEach((ms) => {
    setTimeout(async () => {
      try {
        const r = await page.evaluate(async () => { if (!window.__probeSaveState) return 'no-hook'; await window.__probeSaveState(); return 'saved'; });
        console.log('[probe] PROBE_SAVE_AT @' + ms + 'ms -> ' + r);
      } catch (e) { console.log('[probe] PROBE_SAVE_AT failed: ' + e.message); }
    }, parseInt(ms, 10));
  });

  // ---- page.metrics() snapshots over the run -----------------------------
  // Captures heap size, JS event count, frame count, etc. every
  // METRICS_INTERVAL_MS so we can see growth/leak/stall patterns over time.
  const metricSnaps = [];
  const metricsTimer = setInterval(async () => {
    try {
      const m = await page.metrics();
      m._t = Date.now();
      metricSnaps.push(m);
    } catch (_e) { /* page may be navigating / closed */ }
  }, METRICS_INTERVAL_MS);

  await new Promise((r) => {
    const start = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      if (stuckReason) {
        clearInterval(tick);
        console.log('[probe] STUCK detected at ' + elapsed + 'ms: ' + stuckReason);
        console.log('[probe] grace ' + STUCK_GRACE_MS + 'ms before tearing down');
        setTimeout(r, STUCK_GRACE_MS);
      } else if (elapsed >= TEST_DURATION_MS) {
        clearInterval(tick);
        r();
      }
    }, STUCK_POLL_MS);
  });
  clearInterval(metricsTimer);
  if (stuckReason) console.log('[probe] EXIT-STUCK: ' + stuckReason);

  // ---- stop CPU profiler + categorize self-time --------------------------
  if (CPU_PROFILE && cpuProf.started) {
    let wi = 0;
    for (const ps of cpuProf.sessions) {
      try {
        const { profile } = await ps.s.send('Profiler.stop');
        const named = {}; let total = 0, idle = 0;
        for (const node of (profile.nodes || [])) {
          const h = node.hitCount || 0; if (!h) continue;
          total += h;
          const fn = node.callFrame.functionName || '(anon)';
          if (fn === '(idle)') idle += h;
          named[fn] = (named[fn] || 0) + h;
        }
        if (total === 0) { wi++; continue; }
        const isCpu = !!(named['JitWasm::Run()'] || named['retro_run'] || named['(anon)']);
        const pct = (n) => (100 * n / total).toFixed(1);
        const top = Object.entries(named).sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log('\n--- worker[' + wi + '] ' + (isCpu ? 'CPU/RENDER' : 'pool') + '  total=' + total
          + '  idle=' + pct(idle) + '%  ' + ps.url.replace(/^https?:\/\/[^/]+/, ''));
        top.forEach(([fn, h]) => console.log('  ' + pct(h) + '%  ' + fn));
        try { fs.writeFileSync('/tmp/worker_' + wi + '.cpuprofile', JSON.stringify(profile)); } catch (_e) {}
        wi++;
      } catch (e) { console.error('[probe] Profiler.stop failed (' + ps.url + '): ' + e.message); wi++; }
    }
    console.log('  (per-worker cpuprofiles → /tmp/worker_<i>.cpuprofile)');
  }

  // ---- stop tracing & dump metrics ---------------------------------------
  if (CAPTURE_TRACE) {
    try {
      await page.tracing.stop();
      console.log('[probe] tracing saved → ' + TRACE_PATH);
    } catch (e) {
      console.error('[probe] tracing.stop failed: ' + e.message);
    }
    try {
      fs.writeFileSync(METRICS_PATH, JSON.stringify(metricSnaps, null, 2));
      console.log('[probe] metrics saved → ' + METRICS_PATH + ' (' + metricSnaps.length + ' snapshots)');
    } catch (e) {
      console.error('[probe] metrics write failed: ' + e.message);
    }
  }

  // Non-fatal: a saturated busy scene (heavy GL proxied worker→main) can jam
  // the main thread so this evaluate times out. Don't let it kill the bucket
  // printout — the buckets are collected live via page.on('console').
  let canvasInfo = { found: false, note: 'not-collected' };
  try {
    canvasInfo = await Promise.race([
      page.evaluate(async () => {
        const c = document.getElementById('canvas');
        if (!c) return { found: false };
    // Try main-thread getContext('2d') first — works when paint runs on
    // main thread. Fails with InvalidStateError if the canvas has been
    // transferControlToOffscreen'd to a worker, in which case we fall
    // back to a Puppeteer-friendly screenshot path.
    try {
      const ctx = c.getContext('2d');
      if (ctx) {
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBlack = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] !== 0 || data[i+1] !== 0 || data[i+2] !== 0) nonBlack++;
        }
        return { found: true, has2d: true, w: c.width, h: c.height, nonBlack, total: data.length / 4 };
      }
    } catch (e) {
      // Canvas is owned by an OffscreenCanvas worker; main-thread inspection
      // unavailable. Report dimensions only; live pixel inspection of an
      // OffscreenCanvas-owned target requires worker cooperation.
      return { found: true, has2d: false, offscreen: true, w: c.width, h: c.height, transferredError: String(e) };
    }
    return { found: true, has2d: false, w: c.width, h: c.height };
      }),
      new Promise((res) => setTimeout(() => res({ found: false, note: 'canvasInfo-timeout (main thread saturated)' }), 15000)),
    ]);
  } catch (e) { canvasInfo = { found: false, note: 'canvasInfo-error: ' + e.message }; }

  try { await browser.close(); } catch (_e) {}
  srv.close();

  console.log('\n========== RENDER PROBE RESULT ==========');
  console.log('canvas:', JSON.stringify(canvasInfo));
  console.log('jit_first count:           ' + buckets.jit_first.length);
  buckets.jit_first.slice(0, 3).forEach(l => console.log('  ' + l));
  console.log('jit heartbeat (1M each):   ' + buckets.jit_heartbeat_count);
  console.log('\n--- worker boot transitions ---');
  buckets.worker.forEach(l => console.log('  ' + l));
  console.log('\n--- ipl ---');
  buckets.ipl.forEach(l => console.log('  ' + l));
  console.log('\n--- config ---');
  buckets.config.forEach(l => console.log('  ' + l));
  console.log('\n--- video_cb (count=' + buckets.video_cb.length + ') ---');
  buckets.video_cb.slice(0, 10).forEach(l => console.log('  ' + l));
  console.log('\n--- render (page side) (count=' + buckets.render.length + ') ---');
  buckets.render.slice(0, 10).forEach(l => console.log('  ' + l));
  console.log('\n--- pageerror (count=' + buckets.page_err.length + ') ---');
  buckets.page_err.slice(0, 5).forEach(l => console.log('  ' + l));
  console.log('\n--- jit heartbeat lines (last 8 of ' + buckets.jit_heartbeat_count + ') ---');
  buckets.jit_heartbeat_lines.slice(-8).forEach(l => console.log('  ' + l));
  console.log('\n--- BS2 0x80003140 entry dump ---');
  console.log('\n--- FIX#1 render-worker offload (page-side) ---');
  const _fix1re = /fix.?1|render-worker|GL descriptor|GLRD|render-offload|recording GLctx|\[shim\]|gl-record|hwOffscreen|overlay/i;
  buckets.other.filter(l => _fix1re.test(l)).forEach(l => console.log('  ' + l));
  buckets.render.filter(l => _fix1re.test(l)).forEach(l => console.log('  ' + l));
  buckets.worker.filter(l => _fix1re.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- ppc-worker handshake ---');
  buckets.other.filter(l => /\[ppc-worker/.test(l)).forEach(l => console.log('  ' + l));
  buckets.other.filter(l => /\[3140/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- PI external interrupt mask/cause transitions ---');
  buckets.other.filter(l => /\[pi-update\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- DVDThread activity (start / proc / finish) ---');
  buckets.other.filter(l => /\[dvd-/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- 0x800e52f4 stuck-PC dump ---');
  buckets.other.filter(l => /\[52f4/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- 0x80011584 stuck-PC dump (PSO) ---');
  buckets.other.filter(l => /\[11584/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- mem_diag (count=' + ((buckets.mem_diag||[]).length) + ') ---');
  (buckets.mem_diag||[]).forEach(l => console.log('  ' + l));
  console.log('\n--- perf_flow (count=' + ((buckets.perf_flow||[]).length) + ') ---');
  (buckets.perf_flow||[]).forEach(l => console.log('  ' + l));
  console.log('\n--- mp4-wedge-diag disp-counts (full) ---');
  buckets.other.filter(l => /\[mp4-wedge-diag\] disp-counts/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- mp4-wedge-diag block-compiled (full) ---');
  buckets.other.filter(l => /\[mp4-wedge-diag\] block-compiled/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- mailbox/tick diag (event-loop starvation pin) ---');
  buckets.other.filter(l => /\[tick-diag\]|\[mailbox-diag\]/.test(l)).slice(0, 40).forEach(l => console.log('  ' + l));
  const p4c = buckets.other.filter(l => /\[phase4-counters\]/.test(l));
  console.log('--- phase4-counters (first 3 + last 3 of ' + p4c.length + ') ---');
  p4c.slice(0, 3).concat(p4c.length > 6 ? ['  ...'] : [], p4c.slice(-3)).forEach(l => console.log('  ' + l));
  console.log('\n--- other (last 15 of ' + buckets.other.length + ') ---');
  buckets.other.slice(-15).forEach(l => console.log('  ' + l));
  console.log('\n--- wtraj (full, count=' + ((buckets.wtraj||[]).length) + ') ---');
  (buckets.wtraj||[]).forEach(l => console.log(l));
  console.log('\n--- mmio_trace (full, count=' + ((buckets.mmio_trace||[]).length) + ') ---');
  (buckets.mmio_trace||[]).forEach(l => console.log(l));
  console.log('\n--- other matching dolphin/wrapper/diag ---');
  buckets.other.filter(l => /dolphin|wrapper|diag-bare/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- perf milestones ---');
  buckets.other.filter(l => /\[perf(-fb|-op31)?\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- poll-loop dumps ---');
  buckets.other.filter(l => /\[poll\d?-/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- dispatcher-chain trace ---');
  buckets.other.filter(l => /\[disp-trace\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- PI mask writes ---');
  buckets.other.filter(l => /\[pi-mask-w\]|\[pimask-fn\]|\[stw-pi\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- XFB MMIO writes ---');
  buckets.other.filter(l => /\[xfb-top-/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- exception vector dumps ---');
  buckets.other.filter(l => /\[vec-|\[scvec\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- ISI-trap (SRR0 < 0x80000000) ---');
  buckets.other.filter(l => /\[isi-(trap|pc|wr)\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- stack-corrupt store sentinel (incl. .text 0x800e3a4c zone) ---');
  buckets.other.filter(l => /\[stack-corrupt/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- epilogue 0x800e3958 dispatch watch ---');
  buckets.other.filter(l => /\[epi3958\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- r1-transition sentinel ---');
  buckets.other.filter(l => /\[r1-sentinel\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- r1-sentinel-ctx (OSContext bytes at sentinel-fire) ---');
  buckets.other.filter(l => /\[r1-sentinel-ctx\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- r1-valwatch (writes of 0x38500000) ---');
  buckets.other.filter(l => /\[r1-valwatch\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- bad-r1 (HLE_OSLoadContext loaded r1 out of range) ---');
  buckets.other.filter(l => /\[bad-r1\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- JIT MMIO writes reaching dolphin trampolines ---');
  buckets.other.filter(l => /\[w16(-mmio)?\]|\[w32(-mmio)?\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- planter (JIT-emit tripwire: store to mem[0x802bafcc]) ---');
  buckets.other.filter(l => /\[planter\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- planter-trampoline (dolphin_write32 catches stfd/stmw etc) ---');
  buckets.other.filter(l => /\[planter-trampoline\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- planter-val (emit-side: storing val=0x38500000 anywhere) ---');
  buckets.other.filter(l => /\[planter-val\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- r31-transition sentinel ---');
  buckets.other.filter(l => /\[r31-sentinel\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- oslc-bypass (JIT dispatch inside OSLoadContext body but not at entry) ---');
  buckets.other.filter(l => /\[oslc-bypass\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- MSR transitions (all [msr-trans]) ---');
  buckets.other.filter(l => /\[msr-trans\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- MEM1 scan for callback addresses ---');
  buckets.other.filter(l => /\[mem-scan\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- PSO apploader disasm ---');
  buckets.other.filter(l => /\[pso-disasm\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- PSO DVDLowInquiry buffer ---');
  buckets.other.filter(l => /\[pso-dvd-buf\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- HLE/scan/patched ---');
  buckets.other.filter(l => /HLE|scan|patched|Run\(\) entry/i.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- totaldb / signature-DB activity ---');
  buckets.other.filter(l => /totaldb|signature|SignatureDB|symbol|sym@/i.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- partition cross-region edge probe ---');
  buckets.other.filter(l => /\[partition\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- DUMP-START markers ---');
  buckets.other.filter(l => /DUMP-START/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- DI/CoreTiming/PI diagnostic trace ---');
  buckets.other.filter(l => /\[DI-DICR\]|\[DI-FIN\]|\[di\]|\[CT-ADV\]|\[CT-EVT\]|\[pi\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- jit-trace (jit-pre-outer/outer/inner) ---');
  buckets.other.filter(l => /\[jit-(pre-)?(outer|inner)\]/.test(l)).forEach(l => console.log('  ' + l));
  console.log('\n--- bemental pre-dispatch FIRST 30 (of ' + buckets.bemental_predispatch.length + ') ---');
  buckets.bemental_predispatch.slice(0, 30).forEach(l => console.log('  ' + l));
  console.log('\n--- bemental pre-dispatch LAST 30 (of ' + buckets.bemental_predispatch.length + ') ---');
  buckets.bemental_predispatch.slice(-30).forEach(l => console.log('  ' + l));
  console.log('\n--- bemental traps (count=' + buckets.bemental_traps.length + ') ---');
  buckets.bemental_traps.slice(-20).forEach(l => console.log('  ' + l));
  console.log('\n--- slice timing (last 30 of ' + buckets.slice.length + ') ---');
  buckets.slice.slice(-30).forEach(l => console.log('  ' + l));
  console.log('\n--- vec-dump (count=' + buckets.vec_dump.length + ') ---');
  buckets.vec_dump.forEach(l => console.log('  ' + l));
  console.log('\n--- panic entry (count=' + buckets.panic_entry.length + ') ---');
  buckets.panic_entry.forEach(l => console.log('  ' + l));
  console.log('\n--- wild jump (count=' + buckets.wild_jump.length + ') ---');
  buckets.wild_jump.forEach(l => console.log('  ' + l));

  process.exit(0);
})().catch((err) => { console.error('probe error:', err); process.exit(2); });
