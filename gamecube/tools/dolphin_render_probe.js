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
    headless: process.env.PROBE_HEADLESS === '0' ? false : 'new',
    // Persistent profile so IndexedDB savestates (SAVE_KEY) survive across runs —
    // lets the slow PSO boot be checkpointed and resumed (PROBE_LOAD_IDB_MS).
    ...(process.env.PROBE_PROFILE_DIR ? { userDataDir: process.env.PROBE_PROFILE_DIR } : {}),
    // V8 flag default = `--no-liftoff` (TurboFan-only). On the post-
    // gate JIT (lever-2 + andc + HLE-check inline), this measured 2.2x
    // throughput vs default V8 (Liftoff baseline + dynamic-tiering)
    // on real-game SAB. Override via PROBE_JS_FLAGS env var.
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
           // [pace determinism 2026-07-06] headless Chrome throttles page timers for
           // "backgrounded" tabs (setTimeout chains → 1Hz; IntensiveWakeUpThrottling →
           // 1/min after 5min). Measured as 25fps-vs-2fps run-to-run pace forks on
           // identical builds. Pin the scheduler.
           '--disable-background-timer-throttling',
           '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows',
           '--disable-features=IntensiveWakeUpThrottling',
           // [wgpu probe] real-Chrome WebGPU (Dawn/Metal) for ?wgpu=1 runs.
           // PROBE_NO_WEBGPU=1 forces WebGPU UNAVAILABLE to reproduce the user's live Chrome
           // ("Failed to create WebGPU Context Provider") — tests whether WebGPU-failure stalls
           // the CPU boot at frame 0 (headful WITH webgpu boots to 100; user WITHOUT stalls at 0).
           ...(process.env.PROBE_NO_WEBGPU === '1'
               ? ['--disable-features=WebGPU,WebGPUService']
               : process.env.PROBE_VANILLA_WEBGPU === '1'
               ? []  // vanilla: no webgpu flag at all — matches the user's normal Chrome exactly
               : ['--enable-unsafe-webgpu']),
           // [overlay-teardown-race] crbug 948249 / issues.chromium.org/40621077: on macOS
           // ANGLE-Metal, viz promotes the worker-owned OffscreenCanvas backbuffer to a
           // CALayer/IOSurface overlay SharedImage every present; a mailbox is torn down
           // before scan-out -> ProduceOverlay "non-existent mailbox" -> "Invalid mailbox"
           // -> GPU process dies ~512 presents. Disabling overlay/delegated compositing
           // removes that present path. Set PROBE_DISABLE_OVERLAYS=0 to A/B against it.
           ...((process.env.PROBE_DISABLE_OVERLAYS === '0') ? [] :
               ['--disable-features=DelegatedCompositing,UseMultipleOverlays,MacOverlays,CanvasOopRasterization',
                '--disable-mac-overlays']),
           `--js-flags=--max-old-space-size=4096 ${process.env.PROBE_JS_FLAGS || '--no-liftoff'}`,
           // [cache-bust] disable Chrome's HTTP cache so pthread WORKERS (which
           // fetch dolphin_worker.js / emcc.js / .wasm by bare name, outside the
           // page's setCacheEnabled scope) always load the freshly-linked build.
           // Otherwise new bridge code silently never runs on the proxy-main pthread.
           '--disk-cache-size=1', '--disable-application-cache', '--disable-back-forward-cache',
           '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
    dumpio: !!process.env.PROBE_DUMPIO,  // pipe Chrome stdout/stderr (GPU crash reason)
  });
  const page = await browser.newPage();
  // GPU-process / page crash reason capture (ANGLE-Metal crash diagnosis).
  page.on('crash', () => console.log('[probe] PAGE CRASHED (renderer/GPU process died)'));
  page.on('error', (e) => console.log('[probe] PAGE ERROR: ' + (e && e.message)));

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
  // [phase-snap] periodic phase progress for nondeterminism diffing: every 20s print
  // one line of the boot-progress markers (probe-side page.evaluate; no runtime cost).
  const _frameMilestones = {};  // [determinism] xpc at first cross of fixed guest frames
  const _fineMiles = {};
  const _fineTimer = setInterval(async () => {
    try {
      const s = await page.evaluate(() => {
        try {
          if (!window.sharedMemory) return null;
          const A = new Uint32Array(window.sharedMemory.buffer);
          const f = A[0x026B0930 >> 2] >>> 0;
          const c = A[0x0250002C >> 2] >>> 0;
          const xpc = c ? (A[c >> 2] >>> 0).toString(16) + ':' + (A[(c + 0x2E0) >> 2] >>> 0).toString(16) : '0';
          return { f, xpc };
        } catch (e) { return null; }
      });
      if (!s) return;
      for (const M of [40, 50, 60, 80, 120]) {
        if (!_fineMiles[M] && (s.f >>> 0) >= M) {
          _fineMiles[M] = s;
          console.log('[fine-mile] F' + M + ' frames=' + s.f + ' xpc=' + s.xpc);
        }
      }
    } catch (e) {}
  }, 50);
  _fineTimer.unref && _fineTimer.unref();
  const phaseTimer = setInterval(async () => {
    try {
      const s = await page.evaluate(() => {
        try {
          if (!window.sharedMemory) return { wait: 1 };
          const A = new Uint32Array(window.sharedMemory.buffer);
          const m1 = A[0x02500020 >> 2] >>> 0;
          const rd32 = (va) => {
            if (!m1) return 0;
            const u8 = new Uint8Array(window.sharedMemory.buffer);
            const o = m1 + (va & 0x01FFFFFF);
            return ((u8[o] << 24 | u8[o+1] << 16 | u8[o+2] << 8 | u8[o+3]) >>> 0);
          };
          return {
            aramWrite: rd32(0x801D4908).toString(16),
            omcurovl: rd32(0x801D3CE0).toString(16),
            peFrames: A.length > 1 ? (A[0x026B0930 >> 2] >>> 0) : 0,
            advN: A[0x026B0984 >> 2] >>> 0,
            wgtLo: (A[0x026B0988 >> 2] >>> 0).toString(16),
            ogtLo: (A[0x026B098C >> 2] >>> 0).toString(16),
            evFired: A[0x026B0990 >> 2] >>> 0,
            aid: A[0x026B0994 >> 2] >>> 0, aram: A[0x026B0998 >> 2] >>> 0, dsp: A[0x026B099C >> 2] >>> 0,
            // [stub500 2026-07-09] the 0x500-spin autopsy: dump the guest instruction words at
            // physical 0x500-0x51C (what the worker re-dispatches) + MEM[0xC0] (OSCurrentContext,
            // the os-ready gate's subject). If 0x500=0x48000000 => `b .` (vector not installed).
            stub500: [0,1,2,3,4,5,6,7].map(function(k){return (rd32(0x80000500 + k*4) >>> 0).toString(16);}).join(','),
            osCtxC0: (rd32(0x800000C0) >>> 0).toString(16),
            // [vec-spin worker autopsy] the 0x500 spin lives in the WORKER's region_dispatch loop.
            // [vec-exit autopsy] attempts (worker loop, every vector dispatch) vs epilogue
            // (block actually ran). attempts climb + epilogue flat => miss loop (no block runs).
            vecAttempts: A[0x026B1800 >> 2] >>> 0, vecLastPc: (A[0x026B1804 >> 2] >>> 0).toString(16),
            vecLastRdOk: A[0x026B1808 >> 2] >>> 0, vecLastNext: (A[0x026B180C >> 2] >>> 0).toString(16),
            vecEpilogue: A[0x026B1810 >> 2] >>> 0, vecExitPc: (A[0x026B1814 >> 2] >>> 0).toString(16),
            // [gekko vec-exit] the LIVE emitter (worker=gekko). gekkoExitN climbs + gekkoExitPc=0x500
            // at the wedge => the gekko vector block commits its own start (outcome-1 bug, right file).
            gekkoExitN: A[0x026B1818 >> 2] >>> 0, gekkoExitPc: (A[0x026B181C >> 2] >>> 0).toString(16),
            // [step1 verify] dolphin retro-run PPC-dispatch count — MUST stay 0 post-takeover.
            retroDispatch: A[0x025010D8 >> 2] >>> 0,
            // [gate-soundness 2026-07-09] guest-EVENT-captured milestone (dolphin snapshots at the
            // peFrames==40/50 SetFinish increment, NOT the wall-clock poll): pc + global_timer at
            // the guest event. If these MATCH across rolls while the wall-clock fine-mile xpc
            // scatters => boot is deterministic, the fine-mile gate is just phase-noisy.
            gm40: (A[0x026B1824 >> 2] >>> 0).toString(16) + ':' + (A[0x026B1820 >> 2] >>> 0).toString(16),
            gm50: (A[0x026B182C >> 2] >>> 0).toString(16) + ':' + (A[0x026B1828 >> 2] >>> 0).toString(16),
            // [STEP 2 REDO acceptance] dSrr0 = the LIVE-loop worker inline-delivery channel
            // (ppc_worker.js, FRESH cells — 0x0600 is AoT-pack-polluted, audit wf_fa7314c9).
            // Assertions: dSrr0 >= 0x80000000 (valid interrupted pc, never 0/vector);
            // dSrr0Msr & 0x87C0FFFF == dSrr0Msr AND (dSrr0Msr & 0x8000) != 0 (true SRR1 image, EE was set);
            // dSrr0N grows post-takeover while extSeen FREEZES (EXT deliveries left dolphin entirely).
            dSrr0: (A[0x026B0630 >> 2] >>> 0).toString(16), dSrr0Msr: (A[0x026B0634 >> 2] >>> 0).toString(16),
            dSrr0N: A[0x026B0638 >> 2] >>> 0,
            // [cfg-provenance — PERMANENT] the ACTIVE configuration this run verified against.
            // cfg bits: 1=C-slice loop, 2=AoT enabled, 4=legacy JS loop. cfgLoopN = loop liveness.
            // packLen = AoT pack byte length (regen fingerprint). A verify without these recorded
            // is invalid (the dead-C-slice / stale-pack false-"done" class).
            cfg: A[0x026B1840 >> 2] >>> 0, cfgLoopN: A[0x026B1848 >> 2] >>> 0,
            packLen: A[0x026B1844 >> 2] >>> 0, packStamp: (A[0x026B184C >> 2] >>> 0).toString(16),
            // [deliv-reconcile — PERMANENT] times the JS cursor adopted a dolphin-delivered redirect.
            reconcileN: A[0x026B1904 >> 2] >>> 0,
            // [gp-ring STEP 3 — PERMANENT] WPAR Atomics ring: head/tail (monotonic), producer
            // fallbacks (bounded-wait exhausted -> sync mailbox), applied (consumer count).
            gpRingHead: A[0x026C0000 >> 2] >>> 0, gpRingTail: A[0x026C0004 >> 2] >>> 0,
            gpRingFall: A[0x026C000C >> 2] >>> 0, gpRingApplied: A[0x026C0010 >> 2] >>> 0,
            // [wFrames STEP 5 — PERMANENT] worker-era UNIQUE presented frames (Presenter::ViSwap
            // non-duplicate; VI CoreTiming-driven, valid under worker ownership — peFrames is not).
            wFrames: A[0x026C0018 >> 2] >>> 0,
            // [pollAdvance — PERMANENT] completion-wait jumps taken (episode-capped).
            pollJumpN: A[0x026C0030 >> 2] >>> 0,
            // packSrr0* = STALE AoT-pack guest-mtspr channel at 0x0600 (contamination monitor only).
            packSrr0N: A[0x026B0608 >> 2] >>> 0,
            gSrr0: (A[0x026B0610 >> 2] >>> 0).toString(16), gSrr0N: A[0x026B0618 >> 2] >>> 0,
            // [stepA 2026-07-09] EXTERNAL_INT deferral↔commit accounting (identity:
            // extSeen == extCommit + extEeRefuse + extVecDefer). Delta across snaps: if
            // (extVecDefer+extSingleOwnerBlk) grows but extCommit is FLAT → deferred EXT
            // bits DROPPED (gate is the wedge). decRefusals = DEC ee-refuse (sole owner 0938).
            extSeen: A[0x026B0828 >> 2] >>> 0, extCommit: A[0x026B0974 >> 2] >>> 0,
            extEeRefuse: A[0x026B0934 >> 2] >>> 0, extVecDefer: A[0x026B093C >> 2] >>> 0,
            extSingleOwnerBlk: A[0x026B0824 >> 2] >>> 0, decRefusals: A[0x026B0938 >> 2] >>> 0,
            // [dsp-probe 2026-07-09] DSP CPU-mailbox handshake. dspLoW FROZEN + dspHiR advancing
            // => guest's LO store (consume trigger) never reaches dolphin (routing gap). dspMboxAtPoll
            // bit31 set (0x8xxxxxxx) = what the spinning poll sees; dspMboxAfter should be 0x7xxxxxxx.
            dspHiW: A[0x026B0A10 >> 2] >>> 0, dspLoW: A[0x026B0A14 >> 2] >>> 0,
            dspRespRdN: A[0x026C0034 >> 2] >>> 0, dspRespVal: (A[0x026C0038 >> 2] >>> 0).toString(16),
            dspUpdN: A[0x026C003C >> 2] >>> 0, dspPushN: A[0x026B1A20 >> 2] >>> 0,
            dspHiPc: (A[0x026B1A28 >> 2] >>> 0).toString(16), dspLoPc: (A[0x026B1A2C >> 2] >>> 0).toString(16),
            dspPushVal: (A[0x026B1A24 >> 2] >>> 0).toString(16),
            dspHiR: A[0x026B0A18 >> 2] >>> 0,
            dspMboxAfter: (A[0x026B0A1C >> 2] >>> 0).toString(16),
            dspMboxAtPoll: (A[0x026B0820 >> 2] >>> 0).toString(16),
            // [exi-cw-probe] EXI DMA_CONTROL writes reaching dolphin's ComplexWrite (count + last val).
            exiCwN: A[0x026B0A20 >> 2] >>> 0, exiCwVal: (A[0x026B0A24 >> 2] >>> 0).toString(16),
            exiCwPc: (A[0x026B1A1C >> 2] >>> 0).toString(16),
            // [LO-dup] duplicate LO sends (re-executed-store class) + [slice-active] delivery defers
            loDupN: A[0x026B1A08 >> 2] >>> 0, sliceDeferN: A[0x026B1A04 >> 2] >>> 0,
            drawDoneN: A[0x026B1A34 >> 2] >>> 0,
            gpSent: A[0x026B1A3C >> 2] >>> 0, gpArrived: A[0x026B1A40 >> 2] >>> 0,
            wpDivergeN: A[0x026B1A44 >> 2] >>> 0,
            // [xfb-live] FNV over 3 stripes of high MEM1 (arena-top XFB territory) — a
            // CHANGING hash across snaps = CPU-decoded video (direct-to-XFB movie) living
            // in guest RAM that the EFB-based present path never shows.
            xfbAddr: (A[0x026B1A68 >> 2] >>> 0).toString(16),
            xfbDims: (A[0x026B1A6C >> 2] >>> 0).toString(16),
            ofReached: A[0x026B1B00 >> 2] >>> 0, voxCalled: A[0x026B1B04 >> 2] >>> 0,
            xfbHash: m1 ? (() => {
              const xa = A[0x026B1A68 >> 2] >>> 0; const pa = xa & 0x01FFFFFF;
              if (!xa || pa > 0x017F0000) return 'noxfb';
              let h = 0x811c9dc5;
              for (let k = 0; k < 0x8000; k += 32) { h ^= A[(m1 + pa + k) >> 2]; h = (h * 0x01000193) >>> 0; }
              return (h >>> 0).toString(16);
            })() : '',
            burstN: A[0x026B1A48 >> 2] >>> 0, wpAfter: (A[0x026B1A4C >> 2] >>> 0).toString(16),
            distAfter: (A[0x026B1A50 >> 2] >>> 0).toString(16),
            rgocN: A[0x026B1A54 >> 2] >>> 0, decIterN: A[0x026B1A58 >> 2] >>> 0,
            gpbEarly: A[0x026B1AB0 >> 2] >>> 0, gpbAdv: A[0x026B1AB4 >> 2] >>> 0,
            rgocChunks: A[0x026B1AB8 >> 2] >>> 0, sddDecode: A[0x026B1ABC >> 2] >>> 0,
            bpTot: A[0x026B1AC0 >> 2] >>> 0, sddReg: A[0x026B1AC4 >> 2] >>> 0,
            rpBefore: (A[0x026B1A5C >> 2] >>> 0).toString(16),
            wrRpN: A[0x026B1A60 >> 2] >>> 0, wrDistN: A[0x026B1A64 >> 2] >>> 0,
            // [render-gate] the MP4 main-loop skip flags (main.c:83): HuDvdErrWait@0x801D3A04
            // (set by ToeThread's ToeDispCheck unless DVDGetDriveStatus==DVD_STATE_END),
            // SR_ExecReset@0x801D3EC0, beforeDvdStatus@0x801D3AE0. Nonzero HuDvdErrWait =
            // the game skips ALL rendering. (guest BE in SAB, byteswap.)
            ffWinN: A[0x026B1A80 >> 2] >>> 0, ffCeilN: A[0x026B1A84 >> 2] >>> 0,
            gpSent: A[0x026B1A3C >> 2] >>> 0, gpArrived: A[0x026B0F00 >> 2] >>> 0,
            peFinEvt: A[0x026B1A8C >> 2] >>> 0, peFinEnSnap: A[0x026B1A90 >> 2] >>> 0,
            peFinRaised: A[0x026B1A94 >> 2] >>> 0, gxFinHandlerN: A[0x026B1A98 >> 2] >>> 0,
            // [drawdone] DrawDone byte @guest 0x801D45F0; DrawDoneCB @0x801D45EC. If DrawDone=1
            // the handler ran+set it but the wake/visibility failed; =0 the handler never set it.
            drawDone: m1 ? (new Uint8Array(window.sharedMemory.buffer)[m1 + 0x1D45F0]) : -1,
            drawDoneCB: m1 ? ((() => { const v = A[(m1 + 0x1D45EC) >> 2] >>> 0;
              return ((v>>>24)|((v>>>8)&0xFF00)|((v&0xFF00)<<8)|((v&0xFF)<<24))>>>0; })()).toString(16) : '',
            globalCounter: m1 ? (() => { const v = A[(m1 + (0x801D3A54 - 0x80000000)) >> 2] >>> 0;
              return ((v>>>24)|((v>>>8)&0xFF00)|((v&0xFF00)<<8)|((v&0xFF)<<24))>>>0; })() : 0,
            renderGate: m1 ? (() => {
              const bs = (ga) => { const v = A[(m1 + ((ga>>>0)-0x80000000)) >> 2] >>> 0;
                return ((v>>>24)|((v>>>8)&0xFF00)|((v&0xFF00)<<8)|((v&0xFF)<<24))>>>0; };
              return 'dvdErrWait=' + bs(0x801D3A04) + ' srReset=' + bs(0x801D3EC0)
                + ' beforeDvdStatus=' + (bs(0x801D3AE0)|0);
            })() : '',
            dvdCmdN: A[0x026B1A70 >> 2] >>> 0, dvdCmd: (A[0x026B1A74 >> 2] >>> 0).toString(16),
            dvdIntN: A[0x026B1A78 >> 2] >>> 0, dvdIntT: A[0x026B1A7C >> 2] >>> 0,
            finInflight: A[0x026B1A30 >> 2] >>> 0,
            // [token-scan] search FIFO memory behind cpWp (guest phys, 2KB window) for the
            // draw-done BP pattern 61 45 00 00 02: present-behind-rp = decoder walked past
            // it (decode/accounting); absent = the chunk never landed (target/attach).
            tokenScan: m1 ? (() => {
              const wp = A[0x026B0F28 >> 2] >>> 0;
              if (!wp || wp > 0x01800000) return 'wp?';
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              const base = m1 + Math.max(0, wp - 0x800), end = m1 + wp + 0x40;
              let hits = [];
              for (let a = base; a < end - 5 && hits.length < 4; a++)
                if (u8[a] === 0x61 && u8[a+1] === 0x45 && u8[a+2] === 0 && u8[a+3] === 0 && u8[a+4] === 2)
                  hits.push((a - m1).toString(16));
              return hits.length ? hits.join(',') : 'none';
            })() : '',
            // [fifo-window] hex dump 0x345800..wp+0x20 (the two-token window) for offline
            // GX disassembly — locating the one-byte framing desync.
            fifoDump: m1 ? (() => {
              const wp = A[0x026B0F28 >> 2] >>> 0;
              if (!wp || wp > 0x01800000) return '';
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              const lo = Math.max(0, wp - 0x700), hi = wp + 0x20;
              let out = '';
              for (let a = lo; a < hi; a++) out += u8[m1 + a].toString(16).padStart(2, '0');
              return out;
            })() : '',
            // [sc-census] sc execs / 0xC00 deliveries / rfi execs — spurious-0xC00 discriminator
            scExecN: A[0x026B1A0C >> 2] >>> 0, scDelivN: A[0x026B1A10 >> 2] >>> 0,
            rfiExecN: A[0x026B1A14 >> 2] >>> 0,
            // mailbox state @0x02000000 (MBX_OFF_*: cmd/arg0/reqReady@12/replyReady@20)
            mbx: [A[0x02000000 >> 2], A[0x02000004 >> 2], A[(0x02000000 + 12) >> 2],
                  A[(0x02000000 + 20) >> 2]].map(x => (x >>> 0).toString(16)).join('/'),
            wpc: (A[0x02400000 >> 2] >>> 0).toString(16),
            jsBase: (A[0x026B0E98 >> 2] >>> 0).toString(16),
            realCtx: (A[0x0250002C >> 2] >>> 0).toString(16),
            reread: (A[0x026B0E9C >> 2] >>> 0).toString(16),
            smooth1: A[0x026B0E48 >> 2] >>> 0, smooth2: A[0x026B0E4C >> 2] >>> 0,
            wgt: (A[0x0268000C >> 2] >>> 0).toString(16) + ':' + (A[0x02680008 >> 2] >>> 0).toString(16),
            drainA: A[0x026B0EF0 >> 2] >>> 0, drainS: A[0x026B0EF4 >> 2] >>> 0,
            ctf: A[(0x02680000 + 0x2C) >> 2] >>> 0,
            cpDist: A[0x026B0EF8 >> 2] >>> 0, cpPumps: A[0x026B0EFC >> 2] >>> 0,
            gpW: A[0x026B0F00 >> 2] >>> 0, gpD: A[0x026B0F04 >> 2] >>> 0,
            gpDiscard: A[0x026B0F08 >> 2] >>> 0,
            gpFifoW: A[0x026B0F0C >> 2] >>> 0, gpFifoDrop: A[0x026B0F10 >> 2] >>> 0,
            gpSeals: A[0x026B0F14 >> 2] >>> 0, gpBursts: A[0x026B0F18 >> 2] >>> 0,
            gpTrue: A[0x026B0F1C >> 2] >>> 0, gpCount: A[0x026B0F20 >> 2] >>> 0,
            cpFlags: A[0x026B0F24 >> 2] >>> 0,
            cpWp: (A[0x026B0F28 >> 2] >>> 0).toString(16), cpRp: (A[0x026B0F2C >> 2] >>> 0).toString(16),
            resid: Array.from({length: 8}, (_, k) =>
              (A[(0x026B0F30 >> 2) + k] >>> 0).toString(16).padStart(8, '0')).join(' '),
            p4br: A[0x025010CC >> 2] >>> 0, svci: A[0x025010D0 >> 2] >>> 0, retror: A[0x025010D4 >> 2] >>> 0,
            wring: Array.from({length: 16}, (_, k) =>
              (A[(0x026B1000 >> 2) + ((((A[0x026B1404 >> 2] >>> 0) + 240 + k) & 255))] >>> 0).toString(16)).join(','),
            pcringN: A[0x026B0E44 >> 2] >>> 0,
            pcring: Array.from({length: 64}, (_, k) =>
              (A[(0x026B0A40 >> 2) + ((((A[0x026B0E44 >> 2] >>> 0) + 192 + k) & 255))] >>> 0).toString(16)).join(','),
            ring: Array.from({length: 4}, (_, k) =>
              [A[(0x026B0940 >> 2) + k * 4] >>> 0, A[(0x026B0940 >> 2) + k * 4 + 1] >>> 0,
               A[(0x026B0940 >> 2) + k * 4 + 2] >>> 0, A[(0x026B0940 >> 2) + k * 4 + 3] >>> 0]
                .map(x => x.toString(16)).join('/')).join(','),
            xpc: (() => { const c = A[0x0250002C >> 2] >>> 0; return c ?
              (A[c >> 2] >>> 0).toString(16) + ':' + (A[(c + 0x2E0) >> 2] >>> 0).toString(16)
              + ':' + (A[(c + 0x2EC) >> 2] >>> 0).toString(16) : '0'; })(),
            gc: rd32(0x801D3A54) >>> 0,
            xpc: (() => { const c=A[0x0250002C>>2]>>>0; return c ? (A[c>>2]>>>0).toString(16)+':'+(A[(c+0x2E0)>>2]>>>0).toString(16) : '0'; })(),
            prcSleep: rd32(0x8042c340 + 0x24) >>> 0,
            viFires: A[0x026B0834 >> 2] >>> 0, viAsserts: A[0x026B0838 >> 2] >>> 0,
            viIR: (A[0x026B083C >> 2] >>> 0).toString(16),
            exitReason: A[0x025000A4 >> 2] >>> 0,
            ackPc: (A[0x026B1430 >> 2] >>> 0).toString(16), ackIters: A[0x026B1434 >> 2] >>> 0,
            ackCompiles: A[0x026B1438 >> 2] >>> 0, ackN: A[0x026B143C >> 2] >>> 0,
            ackMs: A[0x026B1444 >> 2] >>> 0, interpN: A[0x026B1440 >> 2] >>> 0,
            spinN: A[0x026B1448 >> 2] >>> 0, spinEE1: A[0x026B144C >> 2] >>> 0, spinExc: (A[0x026B1450 >> 2] >>> 0).toString(16),
            piCause: (A[0x026B1454 >> 2] >>> 0).toString(16), piMask: (A[0x026B1458 >> 2] >>> 0).toString(16),
            rfiN: A[0x026B1470 >> 2] >>> 0, rfiMsrBefore: (A[0x026B1474 >> 2] >>> 0).toString(16),
            rfiSrr1: (A[0x026B1478 >> 2] >>> 0).toString(16), rfiMsrAfter: (A[0x026B147C >> 2] >>> 0).toString(16),
            rfiEELost: A[0x026B1480 >> 2] >>> 0,
            mtmsrLowPc: (A[0x026B0620 >> 2] >>> 0).toString(16), mtmsrLowVal: (A[0x026B0624 >> 2] >>> 0).toString(16), mtmsrLowN: A[0x026B0628 >> 2] >>> 0,
            b7a58N: A[0x026B0A34 >> 2] >>> 0, b7a58Next: (A[0x026B0A38 >> 2] >>> 0).toString(16),
            b7a58Msr: (A[0x026B0A3C >> 2] >>> 0).toString(16), b7a58Exc: (A[0x026B0A40 >> 2] >>> 0).toString(16),
            viCause: (A[0x026B0A44 >> 2] >>> 0).toString(16), viGlobal: (A[0x026B0A48 >> 2] >>> 0).toString(16),
            viLocal: (A[0x026B0A50 >> 2] >>> 0).toString(16), viHwMask: (A[0x026B0A54 >> 2] >>> 0).toString(16), viCauseN: A[0x026B0A4C >> 2] >>> 0,
            piMaskWrites: (() => { const hd = A[0x026B0B40 >> 2] >>> 0; const out = [];
              for (let k = 0; k < 8; k++) { const b = (0x026B0A60 >> 2) + k * 6;
                out.push('v=' + (A[b]>>>0).toString(16) + ' pc=' + (A[b+1]>>>0).toString(16) + ' lr=' + (A[b+2]>>>0).toString(16)
                  + ' C4=' + (A[b+3]>>>0).toString(16) + ' C8=' + (A[b+4]>>>0).toString(16) + ' hw=' + (A[b+5]>>>0).toString(16)); }
              return 'head=' + hd + ' | ' + out.join(' || '); })(),
            viFlip: 'flag=' + (A[0x026B0D0C >> 2]>>>0) + ' newSW=0x' + (A[0x026B0D00 >> 2]>>>0).toString(16)
              + ' prevSW=0x' + (A[0x026B0D04 >> 2]>>>0).toString(16) + ' pc=0x' + (A[0x026B0D08 >> 2]>>>0).toString(16)
              + ' HWmask=0x' + (A[0x026B0D10 >> 2]>>>0).toString(16),
            ilN: A[0x026B1484 >> 2] >>> 0, ilPc: (A[0x026B1488 >> 2] >>> 0).toString(16),
            ilMsr: (A[0x026B148C >> 2] >>> 0).toString(16), ilExc: (A[0x026B1490 >> 2] >>> 0).toString(16), ilEE0: A[0x026B1494 >> 2] >>> 0,
            piCtxExc: (A[0x026B145C >> 2] >>> 0).toString(16), piCtxMsr: (A[0x026B1460 >> 2] >>> 0).toString(16),
            exiR: (A[0x026B1410 >> 2] >>> 0).toString(16) + '=' + (A[0x026B1414 >> 2] >>> 0).toString(16) + ' n' + (A[0x026B1418 >> 2] >>> 0),
            exiW: (A[0x026B141C >> 2] >>> 0).toString(16) + '=' + (A[0x026B1420 >> 2] >>> 0).toString(16) + ' n' + (A[0x026B1424 >> 2] >>> 0),
            // [snap-validate] identity checks: real SAB has this byteLength + mem1 slot
            bl: window.sharedMemory.buffer.byteLength,
            m1: m1.toString(16),
            // [vi-wake characterization] MP4 retraceCount SDA @ guest 0x1D4428 (byteswapped)
            // + the VI TFBL/BFBL XFB base regs the guest programs via VIFlush. If retrace
            // climbs but the XFB regs never change post-takeover, the video thread never
            // flushed; if retrace is frozen, the VI retrace arm never dispatched.
            guestRetrace: m1 ? (() => { const v = A[(m1 + 0x1D4428) >> 2] >>> 0;
              return ((v>>>24)|((v>>>8)&0xFF00)|((v&0xFF00)<<8)|((v&0xFF)<<24))>>>0; })() : 0,
            // [thread-table] walk the guest OS active-thread list from __gCurrentThread
            // (guest 0x800000E4; dolsdk OSThread: state@+0x2C8(u16) prio@+0x2D0
            // waitQueue@+0x2DC linkActive@+0x2FC; OSContext srr0@+0x198 lr@+0x84).
            // states: 1=READY 2=RUNNING 4=WAITING 8=MORIBUND.
            guestThreads: m1 ? (() => {
              const bs = (v) => ((v>>>24)|((v>>>8)&0xFF00)|((v&0xFF00)<<8)|((v&0xFF)<<24))>>>0;
              const rd = (ga) => (ga && (ga>>>0) >= 0x80000000 && (ga>>>0) < 0x81800000)
                ? bs(A[(m1 + ((ga>>>0) - 0x80000000)) >> 2] >>> 0) : 0;
              // active queue head @0x800000DC (verified: MP4 OSCreateThread+0xC8 dol bytes
              // 'lis r4,0x8000 ... stw r31,0xdc(r4)'); cur (0xE4) is NULL while SelectThread idles.
              const head = bs(A[(m1 + 0xDC) >> 2] >>> 0);
              const cur = bs(A[(m1 + 0xE4) >> 2] >>> 0);
              const seen = new Set(); const out = ['cur=' + cur.toString(16)];
              const emit = (t) => {
                if (!t || seen.has(t) || seen.size > 15) return 0;
                seen.add(t);
                const st = rd(t + 0x2C8) >>> 16;
                out.push((t>>>0).toString(16) + ':s' + st
                  + ':p' + rd(t + 0x2D0)
                  + ':q' + (rd(t + 0x2DC)>>>0).toString(16)
                  + ':pc' + (rd(t + 0x198)>>>0).toString(16)
                  + ':lr' + (rd(t + 0x84)>>>0).toString(16));
                return t;
              };
              let n = head; while (n && emit(n)) n = rd(n + 0x2FC);
              // wait-queue contents for the two observed queues: is the READY thread
              // still LINKED in its old wait queue (torn wake: state flipped, dequeue
              // lost) or fully dequeued (RunQueue enqueue lost)?
              out.push('q5458=' + (rd(0x801a5458)>>>0).toString(16) + '/' + (rd(0x801a545C)>>>0).toString(16));
              out.push('q45f4=' + (rd(0x801d45f4)>>>0).toString(16) + '/' + (rd(0x801d45f8)>>>0).toString(16));
              // [scheduler-bits] 0x801a5458 IS RunQueue[8] (RunQueue base 0x801a5418 from
              // OSWakeupThread+0x1c dol bytes, 8-byte entries) — the "wake" completed and
              // the thread IS run-queued. SelectThread idles over it iff RunQueueBits
              // (r13-0x70d0, bit 31-prio) is clear. Dump bits + hint via live gpr13.
              try {
                // r13 = 0x801db420, link-time constant (MP4 __init_registers+0x10 dol bytes:
                // lis r13,0x801d; ori r13,r13,0xb420). RunQueueBits = r13-0x70d0 = 0x801d4350.
                out.push('bits=' + (rd(0x801d4350)>>>0).toString(16)
                  + ' hint=' + (rd(0x801d4354)>>>0).toString(16));
              } catch (e) { out.push('bits-err'); }
              return out.join(' ');
            })() : '',
          };
        } catch (e) { return { err: String(e).slice(0, 60) }; }
      });
      console.log('[phase-snap] ' + JSON.stringify(s));
      // [domino3 ring-bytestream] reconstruct the worker's recorded GX byte stream from the ring
      // (0x026C0000 head, data @0x026C0040 = {width,val} pairs) and dump as hex ONCE post-takeover,
      // so we can decode it offline and find where GX parsing desyncs before the SETDRAWDONE.
      if (!global._ringDumped) {
        try {
          const hx = await page.evaluate(() => {
            const A = new Uint32Array(window.sharedMemory.buffer);
            if ((A[0x026A0000 >> 2] >>> 0) !== 1) return null;   // takeover only
            const head = A[0x026C0000 >> 2] >>> 0;
            if (head < 500) return null;                          // wait until a frame's worth pushed
            const bytes = [];
            const raw = [];   // per-entry {cumOff, w, v} near the divergence for FP-store diagnosis
            for (let i = 0; i < head && i < 4096; i++) {
              const b = (0x026C0040 + (i & 8191) * 8) >> 2;
              const w = A[b] >>> 0, v = A[b + 1] >>> 0;
              const cum = bytes.length;
              if (cum >= 620 && cum <= 720) raw.push(cum + ':' + w + ':' + (v >>> 0).toString(16));
              if (w === 1) bytes.push(v & 0xFF);
              else if (w === 2) { bytes.push((v >>> 8) & 0xFF, v & 0xFF); }
              else { bytes.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF); }
            }
            const nd = A[0x026B1B90 >> 2] >>> 0;
            const draws = [];
            for (let d = 0; d < Math.min(nd, 24); d++) {
              const s = (0x026B1AC8 + d * 8) >> 2;
              draws.push((A[s] >>> 0) + 'x' + (A[s + 1] >>> 0));   // vertex_size x num_vertices
            }
            const nrp = A[0x026B1BF8 >> 2] >>> 0;
            const rps = [];
            const A8b = new Uint8Array(window.sharedMemory.buffer);
            for (let r = 0; r < Math.min(nrp, 32); r++) {
              const addr = (A[(0x026B2000 + r * 4) >> 2] >>> 0).toString(16);
              let hb = '';
              for (let k = 0; k < 32; k++) hb += A8b[0x026B2100 + r * 32 + k].toString(16).padStart(2, '0');
              rps.push(addr + ':' + hb);
            }
            const nc = A[0x026B1BF0 >> 2] >>> 0;
            const A8 = new Uint8Array(window.sharedMemory.buffer);
            const dops = [];
            for (let c = 0; c < Math.min(nc, 200); c++) dops.push(A8[0x026B1C00 + c].toString(16).padStart(2,'0') + ':' + A8[0x026B1E00 + c]);
            const nwt = A[0x026B21F0 >> 2] >>> 0;
            const wts = [];
            for (let r = 0; r < Math.min(nwt, 96); r++) wts.push((A[(0x026B2200 + r * 4) >> 2] >>> 0).toString(16));
            const gpwDrain = A[0x026B1A48 >> 2] >>> 0, gpwOther = A[0x026B1A4C >> 2] >>> 0;
            const otherVals = [];
            for (let r = 0; r < Math.min(gpwOther, 24); r++) otherVals.push((A[(0x026B2600 + r * 4) >> 2] >>> 0).toString(16));
            return { head, hex: bytes.map(x => x.toString(16).padStart(2, '0')).join(''), nd, draws, nc, dops, nrp, rps, nwt, wts, raw, gpwDrain, gpwOther, otherVals };
          });
          if (hx) { global._ringDumped = true; console.log('[ring-bytes] head=' + hx.head + ' bytes=' + hx.hex.length/2 + ' hex=' + hx.hex);
            console.log('[draws] nd=' + hx.nd + ' sizeXcount=' + hx.draws.join(','));
            console.log('[dolphin-ops] nc=' + hx.nc + ' op:size=' + hx.dops.join(' '));
            console.log('[fifo-rptr] nrp=' + hx.nrp + ' addr/word=' + hx.rps.join(' '));
            console.log('[fifo-wtgt] nwt=' + hx.nwt + ' targets=' + hx.wts.join(' '));
            console.log('[ring-raw] cum:w:v=' + hx.raw.join(' '));
            console.log('[gpw-src] drainWrites=' + hx.gpwDrain + ' otherWrites=' + hx.gpwOther + ' otherVals=' + hx.otherVals.join(' ')); }
        } catch (e) {}
      }
      for (const M of [100, 300, 500, 1000]) {
        if (!_frameMilestones[M] && (s.peFrames >>> 0) >= M) {
          _frameMilestones[M] = { frames: s.peFrames, xpc: s.xpc || (s.gc), aram: s.aramWrite };
          console.log('[frame-milestone] F' + M + ' ' + JSON.stringify(_frameMilestones[M]));
        }
      }
    } catch (e) {}
  }, 20000);
  phaseTimer.unref && phaseTimer.unref();

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

  // [si-final] Page-poll-independent SI-crash detection: read the [si-cb] SAB slots
  // (0x026B0920 r4 / 0x0924 cbPre / 0x0928 cbPost / 0x092C count) directly at exit.
  // The gamecube.html [collapse-accept] poll proved unreliable (silently absent on
  // some runs), making "no siN=1 line" indistinguishable from "no crash".
  try {
    const siFinal = await Promise.race([
      page.evaluate(() => {
        try {
          const A = new Uint32Array(sharedMemory.buffer);
          // [seq-ring] dump: 16 entries of [tag, gt_lo, r1, aux] @0x026B0D10, idx @0x026B0D00.
          const idx = A[0x026B0D00 >> 2] >>> 0;
          const names = ['?', 'PADRead', 'OSDispInt', 'SIGetType', 'SIGetResp', 'PADMotor', 'SIGetTypeAsync',
                         'post413', 'postMemcpyE', 'postSIDisPoll', 'postMemcpyH', 'post397', 'memcpy33a8', 'postStmw', 'SITransfer', 'eaWatch', 'eaWatchStmw', 'eaWatchX', 'eaWatchFP', 'hostW32'];
          const seq = [];
          for (let k = 0; k < 16; k++) {
            const e = (0x026B0D10 + (((idx - 16 + k) & 15) << 4)) >> 2;
            const tag = A[e] >>> 0;
            if (!tag) continue;
            seq.push((names[tag] || tag) + ' gt=' + (A[e + 1] >>> 0)
              + ' r1=' + (A[e + 2] >>> 0).toString(16) + ' aux=' + (A[e + 3] >>> 0).toString(16));
          }
          // [vec-dump] raw guest bytes at exception vectors 0x500/0x800/0x900 (BE words).
          const m1 = A[0x02500020 >> 2] >>> 0;
          const vecs = {};
          if (m1) {
            const u8 = new Uint8Array(sharedMemory.buffer);
            for (const v of [0x500, 0x800, 0x900, 0xC00]) {
              let s = '';
              for (let k = 0; k < 16; k++) {
                const o = m1 + v + k * 4;
                s += ((u8[o] << 24 | u8[o+1] << 16 | u8[o+2] << 8 | u8[o+3]) >>> 0).toString(16).padStart(8, '0') + ' ';
              }
              vecs['v' + v.toString(16)] = s.trim();
            }
          }
          // [ctx-hunt] scan MEM1 for OSContext structs whose SRR0 field (+0x198) = the
          // default handler 0x800b4c54 — the source of the r1=0 rfi orbit.
          const hunts = [];
          if (m1) {
            const u8h = new Uint8Array(sharedMemory.buffer);
            for (let a = 0; a < 0x01800000 - 4; a += 4) {
              const o = m1 + a;
              if (u8h[o] === 0x80 && u8h[o+1] === 0x0b && u8h[o+2] === 0x4c && u8h[o+3] === 0x54) {
                // if this is a context's SRR0, the struct starts at a-0x198; gpr[1] at +0x04.
                const cs = a - 0x198;
                let g1 = -1;
                if (cs >= 0) {
                  const go = m1 + cs + 4;
                  g1 = ((u8h[go] << 24 | u8h[go+1] << 16 | u8h[go+2] << 8 | u8h[go+3]) >>> 0);
                }
                hunts.push('0x' + (0x80000000 + a >>> 0).toString(16) + (g1 === 0 ? '(CTX! r1=0)' : ''));
                if (hunts.length >= 10) break;
              }
            }
          }
          // [boot-watch] logo-scene progress: wipeData (0x80192360: mode/type/frame counters),
          // omovlevtno, TB via ctx (spr TBL @ ctx? read global_timer SAB), sampled at exit.
          const bw = {};
          if (m1) {
            const u8b = new Uint8Array(sharedMemory.buffer);
            const rd32 = (va) => {
              const o = m1 + (va & 0x01FFFFFF);
              return ((u8b[o] << 24 | u8b[o+1] << 16 | u8b[o+2] << 8 | u8b[o+3]) >>> 0);
            };
            bw.wipe0 = rd32(0x80192360).toString(16);   // wipeData.mode/type
            bw.wipe4 = rd32(0x80192364).toString(16);   // wipeData +4 (frame/duration)
            bw.wipe8 = rd32(0x80192368).toString(16);
            bw.omovlevtno = rd32(0x801D3CD4).toString(16);
            bw.omovlstat = rd32(0x801D3CCC).toString(16);  // overlay-load state machine
            bw.omcurovl  = rd32(0x801D3CE0).toString(16);  // current overlay (-1 = none)
            bw.omovlhisidx = rd32(0x801D3CD8).toString(16);
            bw.aramWrite = rd32(0x801D4908).toString(16);  // upload progress pointer
            bw.aramTop = rd32(0x801D490C).toString(16);
            bw.arqValid = rd32(0x801D02B8).toString(16);    // aramQueueLo.valid (spin condition)
            bw.exc = (A[(0x02400000 + 0x2EC) >> 2] >>> 0).toString(16);
            bw.msr = (A[(0x02400000 + 0x2E0) >> 2] >>> 0).toString(16);
            bw.pc  = (A[0x02400000 >> 2] >>> 0).toString(16);
            bw.srr0 = (A[(0x02400000 + 0x340 + 26 * 4) >> 2] >>> 0).toString(16);
            bw.srr1 = (A[(0x02400000 + 0x340 + 27 * 4) >> 2] >>> 0).toString(16);
            bw.dar  = (A[(0x02400000 + 0x340 + 19 * 4) >> 2] >>> 0).toString(16);
            bw.dsisr= (A[(0x02400000 + 0x340 + 18 * 4) >> 2] >>> 0).toString(16);
            // OS exception-handler table (0x80003000 + 4*i): junk entries = trampled table
            let _ht = '';
            for (let k = 0; k < 15; k++) _ht += rd32(0x80003000 + k * 4).toString(16) + ',';
            bw.htab = _ht;
            // [thread-walk] every OSThread on __OSActiveThreadQueue: state + saved srr0/lr/r1
            // (OSThread: context@0 [srr0@+0x198, lr@+0x84, gpr1@+0x04], state@0x2C8,
            //  linkActive@0x2FC per dolsdk OSThread.h). Names the sleeper + its wait site.
            let tw = [];
            let thr = rd32(0x800000DC);  // __OSActiveThreadQueue.head (verify vs symbols)
            for (let k = 0; k < 12 && (thr >>> 28) === 8; k++) {
              // stack backchain: 0(r1)=caller frame, 4(frame)=saved LR — the wait chain.
              let chain = '';
              let fr = rd32(thr + 0x04);
              for (let d = 0; d < 8 && (fr >>> 28) === 8; d++) {
                const slr = rd32(fr + 4);
                if ((slr >>> 28) === 8) chain += slr.toString(16) + '>';
                fr = rd32(fr);
              }
              tw.push('t=' + thr.toString(16)
                + ' st=' + (rd32(thr + 0x2C8) >>> 16).toString(16)
                + ' q=' + rd32(thr + 0x2DC).toString(16)
                + ' srr0=' + rd32(thr + 0x198).toString(16)
                + ' stk=' + chain);
              thr = rd32(thr + 0x2FC);  // linkActive.next
            }
            bw.threads = tw;
            // [prc-walk] HuPrc process list: processtop @0x801D3B44; Process: next@0,
            // heap@0x18, exec@0x1C(u16), stat@0x1E(u16), prio@0x20, sleep_time@0x24,
            // jump@0x2C (lr first word). exec: 0=NORMAL 1=SLEEP? (enum from decomp usage).
            let pw = [];
            let prc = rd32(0x801D3B44);
            for (let k = 0; k < 10 && (prc >>> 28) === 8; k++) {
              const execStat = rd32(prc + 0x1C);
              pw.push('p=' + prc.toString(16)
                + ' exec=' + ((execStat >>> 16) & 0xFFFF).toString(16)
                + ' stat=' + (execStat & 0xFFFF).toString(16)
                + ' sleep=' + (rd32(prc + 0x24) | 0)
                + ' lr=' + rd32(prc + 0x30).toString(16)   // jump @0x30 (jmp_buf align-8: flt_regs doubles)
                + ' sp=' + rd32(prc + 0x38).toString(16)
                + ' stk=' + (function (sp0) {
                    let s = '', fr = sp0;
                    for (let d = 0; d < 6 && (fr >>> 28) === 8; d++) {
                      const slr = rd32(fr + 4);
                      if ((slr >>> 28) === 8) s += slr.toString(16) + '>';
                      fr = rd32(fr);
                    }
                    return s;
                  })(rd32(prc + 0x38)));
              prc = rd32(prc);
            }
            bw.prcs = pw;
            // [dvd-state] guest DVD driver: executing @0x801D43D0 (current command block,
            // stuck-nonzero = completion lost), DVDInitialized @0x801D4410.
            // what lives at the odd frame target 0x80df42e0 (code or data?)
            let dfw = '';
            for (let k = 0; k < 8; k++) dfw += rd32(0x80df42c0 + k * 4).toString(16).padStart(8, '0') + ' ';
            bw.df = dfw;
            bw.globalCounter = rd32(0x801D3A54) >>> 0;  // main-loop frame count @GlobalCounter
            bw.gxFinishN = (A[0x026B1A98 >> 2] >>> 0); bw.viRetHandN = (A[0x026B1AA0 >> 2] >>> 0); bw.huDecodeN = (A[0x026B1AA4 >> 2] >>> 0); bw.huDvdErrWait = rd32(0x801D3A04) >>> 0; bw.retraceCount = rd32(0x801D4428) >>> 0; bw.huSoftReset = rd32(0x801D3A00) >>> 0; bw.arqCnt = rd32(0x801D3E04) >>> 0;         // [arq-spin 2026-07-17] HuAR_DVDtoARAM spins while(arqCnt!=0); ArqCallBack@0x800490ac decrements on ARAM-completion ISR
            bw.v500runs = (A[0x026B0680 >> 2] >>> 0);     // [vec-dispatch-trace] count of 0x500-block runs
            bw.v500next = (A[0x026B0684 >> 2] >>> 0).toString(16);  // next-pc the 0x500 block returned (0x504 split? 0x588/0x578 bne target?)
            bw.v500msr = (A[0x026B0688 >> 2] >>> 0).toString(16);   // MSR at 0x500-block run
            bw.vgbrkPc = (A[0x026B068C >> 2] >>> 0).toString(16);   // guard-break pc
            bw.piCauseMirror = (A[0x026B27D0 >> 2] >>> 0).toString(16);  // [pi-mirror 2026-07-17] live guest-visible PI cause (bit0x4=DI, 0x40=DSP, 0x100=VI) — stuck bit = missed ISR ack
            bw.delivSrr0 = (A[0x026B0630 >> 2] >>> 0).toString(16);  // [vec-rfi] worker EXT delivery SRR0
            bw.delivSrr1 = (A[0x026B0634 >> 2] >>> 0).toString(16);  // [vec-rfi] worker EXT delivery SRR1 — bit0x2=RI; if CLEAR the 0x500 vector routes to the UNRECOVERABLE fault path
            bw.liveSrr1 = (() => { const c = A[0x0250002C >> 2] >>> 0; return c ? (A[(c + 0x3AC) >> 2] >>> 0).toString(16) : '0'; })();  // ppc_state SRR1
            { const _ctx = rd32(0x800000C0) >>> 0;   // OSCurrentContext
              bw.savedSrr0 = _ctx ? (rd32(_ctx + 0x198) >>> 0).toString(16) : '0';  // vector-saved ctx->srr0
              bw.osDefExc = (A[0x026B1A9C >> 2] >>> 0); bw.savedSrr1b = _ctx ? (rd32(_ctx + 0x19c) >>> 0).toString(16) : '0'; }  // vector-saved ctx->srr1 — RI(0x2) is what the bne 0x574 tests
            // [round-trip profiler 2026-07-18] mailbox round-trips by cmd during the decode.
            bw.rtcTotal = (A[0x025000FC >> 2] >>> 0);
            bw.rtcByCmd = [2,3,4,8,9,10,14].map(c => c + ':' + (A[(0x02500100 + (c<<2)) >> 2] >>> 0)).join(' ');
            bw.m1fp = (A[0x025000F8 >> 2] >>> 0);         // MEM1-direct fastpath hits (should be ~0: MEM1 is inlined)
            bw.hleFpMiss = (A[0x02500180 >> 2] >>> 0);    // hle_check fastpath misses (no round-trip)
            bw.sysFp = (A[0x02500184 >> 2] >>> 0);         // mfcr/mtcrf sys-op fastpath hits (no round-trip)
            // [MDObjMesh alloc-spin diag 2026-07-18] read the computed buffer sizes (huge = wrong face count)
            { const _m1b = (A[0x02500020 >> 2] >>> 0); const _g32 = (ga) => { if(!_m1b) return 0; const w = A[((_m1b + (ga & 0x01FFFFFF)) >>> 0) >> 2] >>> 0; return (((w & 0xFF) << 24) | ((w & 0xFF00) << 8) | ((w >>> 8) & 0xFF00) | (w >>> 24)) >>> 0; };
              bw.DLTotalNum = _g32(0x801D3BB0) | 0;            // s32 computed DL buffer size
              bw.matChgCnt = _g32(0x801D3BBC) & 0xFFFF;        // u16 @0x801D3BBE (low half of word @BBC)
              bw.faceCnt = (_g32(0x801D3BB8) >>> 16) & 0xFFFF; // u16 @0x801D3BB8 (high half)
              bw.DrawData = '0x'+(_g32(0x801D3C14) >>> 0).toString(16);
              bw.DLBufStartP = '0x'+(_g32(0x801D3C18) >>> 0).toString(16);
              bw.totalPolyCnt = _g32(0x801D3BE4) >>> 0;        // billions = looping; thousands = normal
              bw.drawCnt = _g32(0x801D3C10) | 0;
              // GlobalCounter object-loop context: read GXDrawDone queue + HuSysDoneRender reach
              bw.gcObjIdx = '0x'+(_g32(0x801D3C1C) >>> 0).toString(16);
              // [free-list walk 2026-07-19] walk HuMemMemoryAlloc2's circular free-list from head r27
              // (gpr27) via next-ptr @node+0xc; the wedge = this chain never wraps back to r27.
              const _ctx = A[0x0250002C >> 2] >>> 0;
              const _r27 = _ctx ? (A[(_ctx + 0x14 + 27*4) >> 2] >>> 0) : 0;
              const _r31 = _ctx ? (A[(_ctx + 0x14 + 31*4) >> 2] >>> 0) : 0;
              bw.flHead = '0x'+_r27.toString(16); bw.flCur = '0x'+_r31.toString(16);
              if (_r27 >= 0x80000000 && _r27 < 0x81800000 && _m1b) {
                const seen = new Set(); let node = _r27 >>> 0; const out = []; let end = ''; let prevNode = 0;
                for (let i = 0; i < 400; i++) {
                  if (seen.has(node)) { end = 'CYCLE@0x'+node.toString(16); break; }
                  seen.add(node);
                  const sz = _g32(node) >>> 0; const w4 = _g32(node+4) >>> 0;
                  const inuse = (w4 >>> 16) & 0xFF; const magic = (w4 >>> 24) & 0xFF;
                  const nxt = _g32(node+0xc) >>> 0;
                  out.push('0x'+node.toString(16)+'[sz'+sz+',u'+inuse+',m'+magic.toString(16)+',n0x'+nxt.toString(16)+']');
                  prevNode = node;
                  node = nxt;
                  if (node === (_r27 >>> 0)) { end = 'WRAP-OK@'+(i+1)+'nodes'; break; }
                  if (!(node >= 0x80000000 && node < 0x81800000)) { end = 'BADPTR-0x'+node.toString(16); break; }
                }
                if (!end) end = 'NOEND-400';
                bw.freeListEnd = end; bw.freeListN = seen.size;
                bw.freeList = out.slice(0, 20).join(' ');
                // [corrupt-node 2026-07-20] the node whose ->next is the bad ptr, + raw 16 words around it,
                // + its full memory_block header {size@0, magic@4, flag@5, prev@8, next@c, num@10, retaddr@14}.
                bw.freeListTail = out.slice(-4).join(' ');
                if (prevNode >= 0x80000000 && prevNode < 0x81800000) {
                  bw.corruptNode = '0x'+prevNode.toString(16);
                  const cn = []; for (let k = -2; k < 8; k++) cn.push(((_g32(prevNode + k*4))>>>0).toString(16).padStart(8,'0'));
                  bw.corruptWords = cn.join(' ');
                  bw.corruptRetaddr = '0x'+((_g32(prevNode+0x14))>>>0).toString(16);  // who allocated the corrupt block
                  // [dl-window 2026-07-20 TEMP] dump the overflowing DL buffer: the heap block right
                  // before corruptNode is the DL buffer whose generate ran past its reserve. Window
                  // [corruptNode-512, corruptNode+96) = hdr + full 448-byte DL + the spill, hex rows
                  // of 16 for byte-diff against the native oracle's 384-byte reference stream.
                  { const base = (prevNode - 512) >>> 0; const rows = [];
                    for (let off = 0; off < 608; off += 16) {
                      const bs = [];
                      for (let w = 0; w < 4; w++) { const v = _g32(base + off + w*4) >>> 0;
                        bs.push(((v>>>24)&0xFF), ((v>>>16)&0xFF), ((v>>>8)&0xFF), (v&0xFF)); }
                      rows.push('+'+off.toString(16).padStart(3,'0')+': '+bs.map(b=>b.toString(16).padStart(2,'0')).join(' '));
                    }
                    bw.dlWindowBase = '0x'+base.toString(16); bw.dlWindow = rows; }
                }
              } }
            bw.mfcrMismatch = (A[0x02500190 >> 2] >>> 0); bw.mfcrMatch = (A[0x02500194 >> 2] >>> 0); bw.rfiMismatch = (A[0x02500198 >> 2] >>> 0); bw.rfiMatch = (A[0x0250019C >> 2] >>> 0); bw.xerMismatch = (A[0x025001A0 >> 2] >>> 0); bw.xerMatch = (A[0x025001A4 >> 2] >>> 0);
            bw.mem1RdMM = (A[0x025001A8 >> 2] >>> 0); bw.mem1RdOK = (A[0x025001AC >> 2] >>> 0); bw.mem1WrMM = (A[0x025001B0 >> 2] >>> 0); bw.mem1WrOK = (A[0x025001B4 >> 2] >>> 0);
            bw.mmioRdTop = (() => { const rows=[]; for(let b=0;b<256;b++){const sp=0x02500400+b*8; const c=A[(sp+4)>>2]>>>0; if(c) rows.push(['0x'+(A[sp>>2]>>>0).toString(16),c]);} rows.sort((x,y)=>y[1]-x[1]); return rows.slice(0,12).map(r=>r[0]+'='+r[1]).join(' '); })();
            bw.interpHist = Array.from({length:8}, (_,k) => { const sp = 0x02500200 + k*12; const c = A[(sp+8)>>2]>>>0; return c ? ('0x'+(A[sp>>2]>>>0).toString(16)+'/i'+(A[(sp+4)>>2]>>>0).toString(16)+'='+c) : null; }).filter(Boolean).join(' ');
            bw.gtLo = (A[0x02680008 >> 2] >>> 0);         // [det 2026-07-17] worker global_timer lo — is the deterministic ff advancing it? frozen = under-pump
            bw.gtHi = (A[0x0268000C >> 2] >>> 0);         // global_timer hi
            bw.ctNextValid = (A[0x026B0918 >> 2] >>> 0);  // dolphin hybrid-head valid flag (is there a next VI event to target?)
            bw.ctNextLo = (A[0x026B0910 >> 2] >>> 0);     // hybrid-head time lo
            bw.extIdleDeliv = (A[0x026B2760 >> 2] >>> 0); // [ext-during-idle] worker delivered pending EXT at the idle spin (should climb like native's 2523)
            bw.ffAdvN = (A[0x02680038 >> 2] >>> 0);       // [ff-diag] deterministic ff actual advances (target>now)
            bw.ffNoopN = (A[0x0268003C >> 2] >>> 0);      // [ff-diag] ff no-ops (target<=now / due-now fixed point)
            // [decode-progress 2026-07-17] worker is hot in HuDecodeData LZSS loop (r31=decode struct: src@0, remaining@8).
            // gpr[31]=ctx+0x90. src advancing + remaining shrinking = progressing (slow); stuck/huge = worker mis-emit.
            { const c = A[0x0250002C >> 2] >>> 0; if (c) { const g31 = A[(c + 0x90) >> 2] >>> 0;
              bw.dec_r31 = g31.toString(16);
              bw.dec_src = (g31 ? rd32(g31 + 0) : 0).toString(16);
              bw.dec_remain = (g31 ? (rd32(g31 + 8) | 0) : 0); } }
            // [aram-diag 2026-07-16] ARAM-DMA-complete interrupt delivery chain, post-takeover:
            bw.aramComplete = A[0x026B2700 >> 2] >>> 0;   // ARAMint completion event fired (dolphin)
            bw.aramIntActive = A[0x026B2704 >> 2] >>> 0;  // INT_ARAM bit in DSP_CONTROL
            bw.aramIntsSet = A[0x026B2708 >> 2] >>> 0;    // passed DSP_CONTROL enable check
            bw.dspPending = A[0x026B270C >> 2] >>> 0;     // INT_CAUSE_DSP pending in eff_cause
            bw.dspToExt = A[0x026B2710 >> 2] >>> 0;       // passed PI mask -> EXT set in worker Exceptions
            bw.dspCrWrite = A[0x026B2714 >> 2] >>> 0;     // guest DSP_CR (0xCC00500A) writes reaching dolphin
            bw.dspAramAck = A[0x026B2718 >> 2] >>> 0;     // DSP_CR writes with ARAM-clear bit (the ack)
            bw.enDSP = A[0x026B271C >> 2] >>> 0;          // INT_DSP enabled+active (mailbox)
            bw.enARAM = A[0x026B2720 >> 2] >>> 0;         // INT_ARAM enabled+active
            bw.enAID = A[0x026B2724 >> 2] >>> 0;          // INT_AID enabled+active (audio interface DMA)
            // [livepc-diag 2026-07-16 TEMP] live guest pc/msr + guard state + top-8 pc histogram
            bw.livePc = (A[0x026B2728 >> 2] >>> 0).toString(16);
            bw.liveMsr = (A[0x026B272C >> 2] >>> 0).toString(16);
            bw.guardSet = A[0x026B2778 >> 2] >>> 0;
            bw.guardIters = A[0x026B277C >> 2] >>> 0;
            bw.pcHist = Array.from({length: 8}, (_, k) =>
              (A[(0x026B2730 + k * 8) >> 2] >>> 0).toString(16) + ':' + (A[(0x026B2730 + k * 8 + 4) >> 2] >>> 0)
            ).filter(s => !s.startsWith('0:')).join(' ');
            bw.gExtSeen  = A[0x026B2780 >> 2] >>> 0;   // EXT pending at check
            bw.gExtEe    = A[0x026B2784 >> 2] >>> 0;   // + EE=1
            bw.gExtGuard = A[0x026B2788 >> 2] >>> 0;   // + guard clear
            bw.gOsCtx    = (A[0x026B278C >> 2] >>> 0).toString(16); // last osCtx
            bw.gOsOk     = A[0x026B2790 >> 2] >>> 0;   // osCtx passed -> vectored
            bw.gOsRej    = A[0x026B2794 >> 2] >>> 0;   // osCtx rejected
            bw.aidSelfAck = A[0x026B2798 >> 2] >>> 0;  // [aid-selfack] dolphin self-acked AID post-takeover
            bw.reassertN = A[0x026B279C >> 2] >>> 0;    // [ext-reassert] worker dolphin-kick count (EE=1 wait-loop)
            bw.cmd10Defer = A[0x026B27A0 >> 2] >>> 0;    // [ext-storm] cmd-10 EXT deliveries deferred by the guard
            bw.arqIsrN   = A[0x026B27A4 >> 2] >>> 0;      // [arq] __ARQInterruptServiceRoutine runs
            bw.aramCbN   = A[0x026B27A8 >> 2] >>> 0;      // [arq] aramQueueCallback runs (decrements spin byte)
            bw.spinByte  = A[0x026B27AC >> 2] >>> 0;      // [arq] live aramQueueLo depth byte @0x801D0539
            bw.dispN     = A[0x026B27B0 >> 2] >>> 0;      // [arq] __OSDispatchInterrupt runs
            bw.dspHN     = A[0x026B27B4 >> 2] >>> 0;      // [arq] __DSPHandler runs
            bw.wgpGateN  = A[0x026B27E0 >> 2] >>> 0;      // [wgp-order] CP/PI-page MMIO gate checks
            bw.wgpGateWaitN = A[0x026B27E4 >> 2] >>> 0;   // [wgp-order] ...that actually waited on a non-empty ring
            bw.arHN      = A[0x026B27B8 >> 2] >>> 0;      // [arq] __ARHandler runs (calls the AR DMA callback)
            bw.viHide    = A[0x026B27C0 >> 2] >>> 0;      // [vi-dsp-prio] VI hidden from cause read while DSP co-pending
            bw.dspCrReads = A[0x026B27CC >> 2] >>> 0;     // [aram-diag3] guest DSP_CONTROL reads post-takeover
            bw.aramSeen   = A[0x026B27C8 >> 2] >>> 0;     // [aram-diag3] ...of which had ARAM(0x20) set (guest sees it)
            bw.fpCause = A[0x026B27D8 >> 2] >>> 0;         // [fastpath-hit] PI cause reads served from SAB mirror
            bw.fpDspCr = A[0x026B27DC >> 2] >>> 0;         // [fastpath-hit] DSP_CONTROL reads served from SAB mirror
            bw.mwApplied = A[0x02710008 >> 2] >>> 0;       // [mmio-write-fastpath] DSP/AR writes applied via async ring
            bw.ffEnter = A[0x026B2A00 >> 2] >>> 0;         // [ff-cost] ff excursion count
            bw.ffAdv = A[0x026B2A04 >> 2] >>> 0;           // [ff-cost] total Advance() calls in the ff loop
            bw.ffMs = A[0x026B2A08 >> 2] >>> 0;            // [ff-cost] total wall-ms spent in the ff loop
            bw.vHit = A[0x026B2A0C >> 2] >>> 0;            // [vec-wedge] vector-page (0x100-0x3fff) region-dispatch HIT
            bw.vMiss = A[0x026B2A10 >> 2] >>> 0;           // [vec-wedge] vector-page region-dispatch MISS
            bw.vPoll = A[0x026B2A14 >> 2] >>> 0;
            bw.d500cnt = A[0x026B0A44 >> 2] >>> 0;  bw.d500next=(A[0x026B0A48>>2]>>>0).toString(16);
            bw.d500msr=(A[0x026B0A4C>>2]>>>0).toString(16); bw.d500exc=(A[0x026B0A50>>2]>>>0).toString(16);
            bw.b7a58cnt=A[0x026B0A34>>2]>>>0; bw.b7a58next=(A[0x026B0A38>>2]>>>0).toString(16);
            bw.ffHintPub = A[0x026B2A24 >> 2] >>> 0;   // [ff-hint] times worker latched the ff hint
            bw.ffHintPc = (A[0x026B2A28 >> 2] >>> 0).toString(16);
            bw.idleHintLive = A[0x02680030 >> 2] >>> 0; // ff idle-hint cell value
            bw.hintPcLive = (A[0x02680034 >> 2] >>> 0).toString(16);           // [vec-wedge] pollAdvance calls at a vector-page pc
            bw.stall500idle = A[0x026B2A18 >> 2] >>> 0;     // [0x500-stall] 0x500 ate by the downcount idle-continue
            bw.stall500disp = A[0x026B2A1C >> 2] >>> 0;     // [0x500-stall] 0x500 reached the block-dispatch section
            bw.vHit = A[0x026B2A0C >> 2] >>> 0;              // [0x500-stall] vector-page dispatch HIT
            bw.vMiss = A[0x026B2A10 >> 2] >>> 0;            // [0x500-stall] vector-page dispatch MISS
            bw.disp500next = (A[0x026B2A20 >> 2] >>> 0).toString(16);  // [0x500-stall] dispatch return for 0x500
            // [live-pc histogram] top-8 {pc,count} the guest actually visits (worker publishes @0x026B2730, stride 8)
            bw.lpcHist = (() => { const o = []; for (let k = 0; k < 8; k++) { const sp = 0x026B2730 + k * 8;
              const p = A[sp >> 2] >>> 0, c = A[(sp + 4) >> 2] >>> 0; if (c) o.push('0x' + p.toString(16) + ':' + c); } return o.join(' '); })();
            bw.peFrames = A[0x026B0930 >> 2] >>> 0;        // SetFinish counter (SAB, replaces [ax-pe] print)
            bw.eeViolations = A[0x026B0934 >> 2] >>> 0;    // Step-2 tripwire: EXT delivered at EE=0 (must be 0)
            // [crash-ctx] the OS exception context (0x801a5b38 in every captured dump):
            // srr0/srr1 at +0x198/+0x19C = the crash-moment pc/msr, readable without
            // waiting for the guest's minutes-long EXI report print.
            bw.crashSrr0 = rd32(0x801a5b38 + 0x198).toString(16);
            bw.crashSrr1 = rd32(0x801a5b38 + 0x19C).toString(16);
            bw.crashLr   = rd32(0x801a5b38 + 0x84).toString(16);
            bw.crashR1   = rd32(0x801a5b38 + 0x04).toString(16);
            bw.decRefusals = A[0x026B0938 >> 2] >>> 0;     // DEC EE-gate refusals (now sole owner of 0938)
            // [stepA 2026-07-09] EXTERNAL_INT deferral↔commit accounting. Identity:
            //   extSeen == extCommit + extEeRefuse + extVecDefer   (calls that passed single-owner gate)
            // Two-snapshot delta test: if (extVecDefer + extSingleOwnerBlock) grows but extCommit
            // is FLAT, deferred EXT bits are being DROPPED (my gate is the wedge, not a device).
            bw.extSeen           = A[0x026B0828 >> 2] >>> 0; // EXT reached delivery logic (pre-gate)
            bw.extEeRefuse       = A[0x026B0934 >> 2] >>> 0; // EXT ee-gate refusals (same cell as eeViolations)
            bw.extVecDefer       = A[0x026B093C >> 2] >>> 0; // EXT vector-page (stub) defers — clean cell
            bw.extSingleOwnerBlk = A[0x026B0824 >> 2] >>> 0; // single-owner-gate blocks w/ EXT pending (no cmd-10)
            bw.extCommit         = A[0x026B0974 >> 2] >>> 0; // EXT committed deliveries (TRUE deliver count)
            bw.delivRing = Array.from({length: 4}, (_, k) =>
              [A[(0x026B0940 >> 2) + k * 4 + 1] >>> 0, A[(0x026B0940 >> 2) + k * 4 + 2] >>> 0,
               A[(0x026B0940 >> 2) + k * 4 + 3] >>> 0].map(x => x.toString(16)).join('/'));
            bw.delivHead = A[0x026B0970 >> 2] >>> 0;
            bw.vecTrace = Array.from({length: 18}, (_, k) =>
              (A[(0x026B0E50 >> 2) + k] >>> 0).toString(16)).join(',');
            // [isr-trace] blocks executed after the most recent delivery: the deliv-ring's
            // newest entry stamps the wasm-ring head; dump ring[stamp..stamp+32].
            {
              const hd = ((A[0x026B0970 >> 2] >>> 0) + 3) & 3;
              const stamp = A[(0x026B0940 >> 2) + hd * 4 + 3] >>> 0;
              bw.isrTrace = Array.from({length: 32}, (_, k) =>
                (A[(0x026B1000 >> 2) + ((stamp + k) & 255)] >>> 0).toString(16)).join(',');
              bw.isrStamp = stamp;
              bw.wasmHead = A[0x026B1404 >> 2] >>> 0;
            }
            bw.wasmRing = Array.from({length: 16}, (_, k) =>
              (A[(0x026B0EA0 >> 2) + ((((A[0x026B0EE0 >> 2] >>> 0) + k) & 15))] >>> 0).toString(16)).join(',');
            // p2 raw frame words (jump.sp of process 2): first 3 frames unfiltered
            bw.dvdExecuting = rd32(0x801D43D0).toString(16);
            bw.dvdInit = rd32(0x801D4410).toString(16);
            if ((rd32(0x801D43D0) >>> 28) === 8) {
              const cb = rd32(0x801D43D0);
              bw.dvdCmd = rd32(cb + 0x8).toString(16) + '/state=' + rd32(cb + 0xC).toString(16);
            }
            // If the guest is in the printf/fwrite path, dump the strings at r3/r4/r5 —
            // likely the MUSY_ASSERT/OSPanic text that never reaches a console.
            const rdstr = (va) => {
              if ((va >>> 28) !== 8) return '';
              let s = '';
              for (let k = 0; k < 120; k++) {
                const ch = u8b[m1 + ((va + k) & 0x01FFFFFF)];
                if (ch === 0) break;
                s += (ch >= 32 && ch < 127) ? String.fromCharCode(ch) : '.';
              }
              return s;
            };
            bw.r3s = rdstr(A[(0x02400000 + 0x20) >> 2] >>> 0);
            bw.r4s = rdstr(A[(0x02400000 + 0x24) >> 2] >>> 0);
            bw.r5s = rdstr(A[(0x02400000 + 0x28) >> 2] >>> 0);
            bw.r31s = rdstr(A[(0x02400000 + 0x18 + 30 * 4) >> 2] >>> 0);
            bw.gtl = (A[(0x02690000) >> 2] >>> 0).toString(16);  // CT global_timer lo (if mapped)
          }
          return { bw, hunts, vecs,
                   siN: A[0x026B092C >> 2] >>> 0,
                   cbPre: (A[0x026B0924 >> 2] >>> 0).toString(16),
                   cbPost: (A[0x026B0928 >> 2] >>> 0).toString(16),
                   retired: A[0x026B0800 >> 2] >>> 0,
                   seqN: idx, seq };
        } catch (e) { return { err: '' + e }; }
      }),
      new Promise((res) => setTimeout(() => res({ err: 'si-final timeout' }), 10000)),
    ]);
    console.log('[si-final] ' + JSON.stringify(siFinal));
  } catch (_e) { console.log('[si-final] {"err":"evaluate failed"}'); }

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
