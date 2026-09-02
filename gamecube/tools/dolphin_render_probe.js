// Quick probe: does video_cb ever fire? Boot to first frame.
// Captures all console messages and groups them so we can see what the
// boot pipeline did (or didn't do).
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// PROBE_ROOT overrides the served document root. Point it at a snapshot tree
// (symlink farm + real copies of gamecube/dolphin_libretro + gamecube/recomp) so a
// CONCURRENT relink in the live repo cannot swap the .wasm out from under a running
// measurement. That tear is not hypothetical: it produced
// "WebAssembly.instantiate(): Import #0 \"env\": module is not an object or function"
// (torn .js/.wasm pair) and voided a full run on 2026-08-29.
const ROOT = process.env.PROBE_ROOT || '/Users/caseybement/Bemental77.github.io';
// [concurrent-probe fix 2026-08-28] PORT was hardcoded to 8788, so two probes
// running at once killed each other with EADDRINUSE (and, worse, the second
// could silently attach to the FIRST one's server and measure the wrong tree).
// Default is now an OS-assigned ephemeral port; PROBE_PORT=<n> pins it if you
// need a stable URL. Resolved value lands in PORT after startServer().
const PORT_REQUESTED = parseInt(process.env.PROBE_PORT || '0', 10);
let PORT = PORT_REQUESTED;
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
// [pc-sample 2026-07-23] PROBE_PC_SAMPLE=1 installs a page-side guest-PC sampler:
// reads live ppc_state.pc via the published ctx ptr (@0x0250002C, same source as
// bw.xpc), buckets 256B, segments per 10s with gc min/max — the WASM-side twin of
// the native oracle's /tmp/native_pc_hist.txt. Dump → /tmp/wasm_pc_hist.json.
const PC_SAMPLE        = process.env.PROBE_PC_SAMPLE === '1';
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
    // PORT_REQUESTED 0 => OS picks a free ephemeral port; read it back off the
    // listening socket so every later URL uses the port we actually got.
    srv.listen(PORT_REQUESTED, '127.0.0.1', () => { PORT = srv.address().port; resolve(srv); });
  });
}

(async () => {
  const srv = await startServer();
  console.log('[probe] server up on :' + PORT
    + (PORT_REQUESTED ? ' (pinned via PROBE_PORT)' : ' (ephemeral — set PROBE_PORT to pin)'));
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
  // [leak-guard 2026-09-01] A SIGKILLed parent ORPHANS this browser — verified by
  // test, and uncatchable in-process. Seven such orphans from one run were still
  // burning 230.3% of CPU 2 days later, which is what made 'the box is quiet'
  // false for a long run of matched pairs. Registering the PID lets
  // `node tools/browser_leak_guard.js reap` kill it once this process is gone.
  try { require('../../tools/browser_leak_guard.js').guard(browser, __filename); } catch (_e) {}

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
  // [coi-reload settle 2026-08-28] coi-serviceworker.js reloads the page the
  // FIRST time an origin is seen, to install COOP/COEP. With the port now
  // ephemeral, every run is a fresh origin, so that reload happens on EVERY run
  // (with the old hardcoded :8788 the worker was already registered from a
  // previous run, which is why this never showed up before). The reload tears
  // down the execution context and the next page.evaluate throws
  // "Execution context was destroyed" — observed killing a run outright at
  // load average 32. Wait for crossOriginIsolated, tolerating the teardown.
  // NOTE: crossOriginIsolated is NOT the settle signal here — the probe launches
  // Chrome with --disable-web-security, under which it reads false while SAB
  // still works. The signal is simply that the execution context stops being
  // torn down: two consecutive successful evaluates on the same document.
  {
    let ok = 0, tries = 0, lastHref = '';
    while (ok < 2 && tries < 60) {
      tries++;
      try {
        const href = await page.evaluate(() => location.href);
        if (href === lastHref) ok++; else { ok = 1; lastHref = href; }
      } catch (e) { ok = 0; }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log('[probe] document settled after ' + tries + ' polls'
      + (ok < 2 ? ' (NOT SETTLED — coi reload may still fire)' : ''));
  }
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
  // 500ms is ~1.5 guest frames when the scene draws at 3fps, which is marginal for a
  // game that latches on a press EDGE. PROBE_PRESS_HOLD_MS widens it.
  const PRESS_HOLD_MS = parseInt(process.env.PROBE_PRESS_HOLD_MS || '500', 10);
  // page.keyboard emits TRUSTED events → gamecube.html's PHYSICAL-keyboard path
  // (onKey, `if (!e.isTrusted) return`), whose keyToPad is: WASD=analog stick,
  // M/N/J/K=A/B/Y/X, q/r/e/v/c=L/R/Z/Start/Select (gamecube.html:2961-2965).
  // The old map (a:'x' etc.) was the NON-trusted dispatchKey map and silently
  // no-op'd on this path (and l:'w' pressed UP). Match the physical map:
  // The RECOMP path does not share that map. It installs its own listeners with
  // a different binding (gamecube.html:3867): A=KeyX B=KeyZ X=KeyS Y=KeyD Z=KeyE
  // L=KeyW R=KeyR Start=KeyV/Enter. Sending the dolphin map at a recomp build
  // silently no-ops every face button (Start happens to coincide on 'v'), which
  // looks exactly like "input is broken" when it is the probe that is wrong.
  // [KEYMAP BUG FIX 2026-08-29] The non-recomp (JIT) branch mapped
  //   a:'m'  b:'n'  x:'k'  y:'j'  l:'q'
  // and NONE of those keys exist in the page. gamecube.html has exactly ONE keymap,
  // at :1199 — { a:'x', b:'z', x:'s', y:'d', l:'w', r:'r', z:'e', start:'v', select:'c' } —
  // and KEY_CODES at :4233 can only synthesise `x z s d w r e v c` plus the arrows.
  // So on the JIT path ONLY the arrows (and r/e/v/c, which happened to coincide) ever
  // reached the guest: every `a`/`b`/`x`/`y`/`l` press was a SILENT NO-OP that the probe
  // still reported as delivered. That is the exact failure the comment above this line
  // warns about — "looks exactly like 'input is broken' when it is the probe that is
  // wrong" — and it was live on the JIT branch while the recomp branch was correct.
  // It invalidates the INPUT half of any JIT-path campaign that pressed a face button:
  // scenes behind an A-to-dismiss modal were never dismissed, and "could not reproduce
  // under input" is not a safe conclusion from any such run.
  // Both branches now use the page's single keymap verbatim; they are identical by
  // construction rather than by coincidence, so they cannot drift apart again.
  // [KEYMAP RE-FIX 2026-08-29 — MEASURED, not read] The 2026-08-29 "fix" above
  // INVERTED the bug it describes. It swapped the working map for gamecube.html's
  // dispatchKey map (a:'x' b:'z' x:'s' y:'d' l:'w'), but dispatchKey is the
  // TOUCH/synthetic path: it applies pad state itself and its events carry
  // isTrusted=false. page.keyboard emits TRUSTED events, which reach ONLY the
  // physical listener at gamecube.html:4403 -> onKey (`if (!e.isTrusted) return`),
  // whose map is m/n/j/k = A/B/Y/X, q/r/e/v/c = L/R/Z/Start/Select, and
  // w/a/s/d = ANALOG STICK.
  //
  // Settled with a direct pad-buffer witness (PROBE_PAD_WATCH, /tmp/keymap.log),
  // ten presses, reading `Module.HEAPU8[Module._get_ptr(0) + 0..2]`:
  //   key_x -> NO pad change      key_z -> NO pad change     (silent no-ops)
  //   key_s -> Down   key_d -> Right   key_w -> Up           (ANALOG STICK, not X/Y/L)
  //   key_m -> A   key_n -> B   key_j -> Y   key_k -> X   key_q -> L   (correct)
  // So the "fixed" map made 2 of 5 face buttons silent and the other 3 press the
  // stick — strictly worse than what it replaced, and harder to catch, because
  // s/d/w DO move the pad and so look like delivered input.
  //
  // WASD vs the arrows: NOT two different sticks. onKey maps both to the same four
  // pad entries ('up'/'down'/'left'/'right'), so updatePadState sets the same bits
  // (gamecube.html:4364 b0 16/32/64/128) either way — measured: `stickdown` (s) and
  // `down` (ArrowDown) both produced b0=0x20. The analog stick is synthesized
  // worker-side FROM those bits (EmscriptenWorker input_state_cb), so there is no
  // separate stick key to press. The stick* names below are aliases kept only
  // because WASD is what a human would reach for.
  const RECOMP = /(^|&)recomp=1(&|$)/.test(process.env.PROBE_QUERY || '');
  const PAGE_KEYMAP = { start: 'v', select: 'c', a: 'm', b: 'n', x: 'k', y: 'j', l: 'q', r: 'r', z: 'e', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', stickup: 'w', stickdown: 's', stickleft: 'a', stickright: 'd' };
  const PRESS_KEY = PAGE_KEYMAP;
  void RECOMP;  // kept: the two paths install different listeners, so the split may return
  // [raw-key escape hatch 2026-08-29] `key_<char>@<ms>` presses the LITERAL key,
  // bypassing PAGE_KEYMAP. Needed because which map is correct is an EMPIRICAL
  // question about which listener page.keyboard's TRUSTED events reach, and the
  // repo has now shipped two mutually exclusive answers. gamecube.html has THREE
  // keydown listeners, not one:
  //   :4370 dispatchKey's keyToPad  (x=A z=B s=X d=Y w=L) — the TOUCH/synthetic path,
  //         applied directly by dispatchKey; its dispatched events are isTrusted=false.
  //   :4403 onKey -> keyToPad       (m=A n=B j=Y k=X q=L, w/a/s/d = ANALOG STICK) —
  //         gated `if (!e.isTrusted) return`, so this is the ONLY listener a
  //         page.keyboard press can reach on the JIT path.
  //   :6175 the recomp paceI32 map  (KeyX=A KeyZ=B ...) — only live under ?recomp=1.
  // Use key_ to settle it by observation instead of by reading.
  (process.env.PROBE_PRESS || '').split(',').filter(Boolean).forEach((spec) => {
    const m = spec.trim().match(/^(\w+)@(\d+)$/);
    const raw = m && /^key_(.+)$/.exec(m[1]);
    if (!m || (!raw && !PRESS_KEY[m[1]])) { console.log('[probe] PROBE_PRESS spec ignored: ' + spec); return; }
    const key = raw ? raw[1] : PRESS_KEY[m[1]];
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
  //
  // [restore proof 2026-09-01] "loaded N bytes" PROVED NOTHING: it only said the
  // page handed the bytes to the worker, and the worker's ack fired on every
  // failure path too, so a restore that never happened printed an identical line
  // and the run silently measured the COLD BOOT (CLAUDE.md gate #10). Two
  // independent proofs are wired up now:
  //   1. the worker's own tri-state ack (needs the relinked worker_funcs.js —
  //      absent on an older binary, in which case ok is 'unknown', never 'true')
  //   2. PROBE_RESTORE_WITNESS=1, below: a page-side CoreTiming/guest-RAM
  //      discontinuity witness that needs no worker cooperation at all.
  if (process.env.PROBE_LOAD_STATE) {
    const loadAt = parseInt(process.env.PROBE_LOAD_STATE_MS || '25000', 10);
    setTimeout(async () => {
      try {
        const r = await page.evaluate(async () => {
          if (typeof window.__probeLoadStateFromGz !== 'function') return 'no-hook';
          const resp = await fetch('/__probe_state', { cache: 'no-store' });
          if (!resp.ok) return 'fetch-' + resp.status;
          const buf = new Uint8Array(await resp.arrayBuffer());
          const ack = await window.__probeLoadStateFromGz(buf);
          const ok = (ack && ack.ok !== undefined) ? String(ack.ok) : 'unknown(old worker build)';
          window.__restoreAt = performance.now();
          return 'handed ' + buf.byteLength + ' gz bytes to the worker; worker ack ok=' + ok;
        });
        console.log('[probe] PROBE_LOAD_STATE @' + loadAt + 'ms -> ' + r);
      } catch (e) { console.log('[probe] PROBE_LOAD_STATE failed (restore did NOT happen): ' + e.message); }
    }, loadAt);
  }

  // ---- [restore witness] worker-independent proof that DoState really ran ---
  // PROBE_RESTORE_WITNESS=1 samples, every 200ms:
  //   * CoreTiming global_timer (SAB mirror 0x026B3424 lo / 0x026B3428 hi — the
  //     same cell the [mips] meter calls "credited"). gamecube.html:6006-6010
  //     records that a restore REPLACES this with the saved run's clock, so a
  //     restore is a step discontinuity here, while normal execution is a smooth
  //     monotone advance.
  //   * a 512-word fingerprint spread across guest MEM1 (base @0x02500020) —
  //     a restore rewrites the whole 24MB, so the changed-word fraction spikes.
  // Neither reads a worker message, so this cannot be fooled by an ack that lies.
  if (process.env.PROBE_RESTORE_WITNESS === '1') {
    try {
      await page.evaluate(() => {
        window.__rw = { s: [], err: null };
        let prevFp = null;
        setInterval(() => {
          try {
            if (!window.sharedMemory) return;
            const A = new Uint32Array(window.sharedMemory.buffer);
            const m1 = A[0x02500020 >> 2] >>> 0;
            const cred = (A[0x026B3424 >> 2] >>> 0) + (A[0x026B3428 >> 2] >>> 0) * 4294967296;
            let changed = -1;
            if (m1) {
              // 512 words spread over the 24MB MEM1 image.
              const fp = new Uint32Array(512);
              const stride = (24 * 1024 * 1024 / 512) >>> 2;
              for (let i = 0; i < 512; i++) fp[i] = A[((m1 >>> 2) + i * stride) >>> 0] >>> 0;
              if (prevFp) { changed = 0; for (let i = 0; i < 512; i++) if (fp[i] !== prevFp[i]) changed++; }
              prevFp = fp;
            }
            window.__rw.s.push({ t: performance.now(), cred: cred, ch: changed,
                                 pe: A[0x026B0930 >> 2] >>> 0 });
            if (window.__rw.s.length > 4000) window.__rw.s.shift();
          } catch (e) { window.__rw.err = String(e && e.message || e); }
        }, 200);
      });
      console.log('[probe] restore-witness: CoreTiming + MEM1-fingerprint sampler installed');
    } catch (e) { console.error('[probe] restore-witness install failed: ' + e.message); }
  }

  // ---- save-state CREATION (make a menu checkpoint) -----------------------
  // PROBE_SAVE_STATE=<outfile.gz> + PROBE_SAVE_STATE_MS=<t> → at t (ms from Start),
  // trigger the worker DoState save (to IndexedDB) then persist the gz bytes to the
  // outfile for reuse via PROBE_LOAD_STATE. Drive to the menu first with PROBE_PRESS.
  if (process.env.PROBE_SAVE_STATE) {
    const saveAt = parseInt(process.env.PROBE_SAVE_STATE_MS || '60000', 10);
    const outFile = process.env.PROBE_SAVE_STATE;
    setTimeout(async () => {
      try {
        const r = await page.evaluate(async () => {
          if (typeof window.__probeSaveState !== 'function') return 'no-hook';
          await window.__probeSaveState();
          const arr = await window.__probeGetStateGz();
          return arr || 'no-state';
        });
        if (Array.isArray(r)) {
          fs.writeFileSync(outFile, Buffer.from(r));
          console.log('[probe] PROBE_SAVE_STATE @' + saveAt + 'ms -> wrote ' + r.length + ' bytes to ' + outFile);
        } else {
          console.log('[probe] PROBE_SAVE_STATE -> ' + r);
        }
      } catch (e) { console.log('[probe] PROBE_SAVE_STATE failed: ' + e.message); }
    }, saveAt);
  }

  // ---- export the EXISTING IndexedDB save to a portable file --------------
  // PROBE_EXPORT_STATE=<outfile.gz> + PROBE_EXPORT_STATE_MS (default 8000) →
  // read the already-saved SAVE_KEY (from a persistent-profile Save State the
  // user clicked) and write it to a portable .gz WITHOUT re-saving, so it can be
  // reused via PROBE_LOAD_STATE regardless of profile/origin. Fire early — it
  // just reads IndexedDB and does not need the core to be booted.
  if (process.env.PROBE_EXPORT_STATE) {
    const expAt = parseInt(process.env.PROBE_EXPORT_STATE_MS || '8000', 10);
    const outFile = process.env.PROBE_EXPORT_STATE;
    setTimeout(async () => {
      try {
        const r = await page.evaluate(async () => {
          if (typeof window.__probeGetStateGz !== 'function') return 'no-hook';
          const arr = await window.__probeGetStateGz();
          return arr || 'no-state';
        });
        if (Array.isArray(r)) {
          fs.writeFileSync(outFile, Buffer.from(r));
          console.log('[probe] PROBE_EXPORT_STATE -> wrote ' + r.length + ' bytes to ' + outFile);
        } else {
          console.log('[probe] PROBE_EXPORT_STATE -> ' + r);
        }
      } catch (e) { console.log('[probe] PROBE_EXPORT_STATE failed: ' + e.message); }
    }, expAt);
  }

  // ---- screenshot capture (verify what's actually on screen) --------------
  // PROBE_SHOT="/tmp/x.png@50000" → CDP compositor screenshot at that offset.
  // Captures the composited page incl. the worker-owned OffscreenCanvas, which
  // main-thread getImageData cannot reach.
  // [phase-snap] periodic phase progress for nondeterminism diffing: every 20s print
  // one line of the boot-progress markers (probe-side page.evaluate; no runtime cost).
  const _frameMilestones = {};  // [determinism] xpc at first cross of fixed guest frames
  const _fineMiles = {};
  // [fpscr one-shot] print the live guest FPSCR once (ctx+740; NI = bit 2,
  // mask 4). Decides whether the emitted per-ps-op NI denormal-flush arms
  // (~1024 wasm ops/iter in the THP IDCT loop) actually execute at runtime.
  let _fpscrLast = -1;
  const _fineTimer = setInterval(async () => {
    try {
      const s = await page.evaluate(() => {
        try {
          if (!window.sharedMemory) return null;
          const A = new Uint32Array(window.sharedMemory.buffer);
          const f = A[0x026B0930 >> 2] >>> 0;
          const c = A[0x0250002C >> 2] >>> 0;
          const xpc = c ? (A[c >> 2] >>> 0).toString(16) + ':' + (A[(c + 0x2E0) >> 2] >>> 0).toString(16) : '0';
          const fpscr = c ? (A[(c + 740) >> 2] >>> 0) : 0;
          return { f, xpc, fpscr, hasCtx: !!c };
        } catch (e) { return null; }
      });
      if (!s) return;
      if (s.hasCtx && (s.fpscr & 4) !== _fpscrLast) {
        _fpscrLast = s.fpscr & 4;
        console.log('[fpscr] 0x' + s.fpscr.toString(16) + ' NI=' + ((s.fpscr & 4) ? 1 : 0));
      }
      for (const M of [40, 50, 60, 80, 120]) {
        if (!_fineMiles[M] && (s.f >>> 0) >= M) {
          _fineMiles[M] = s;
          console.log('[fine-mile] F' + M + ' frames=' + s.f + ' xpc=' + s.xpc);
        }
      }
    } catch (e) {}
  }, 50);
  _fineTimer.unref && _fineTimer.unref();
  // [pc-sample] page-side guest-PC sampler (see PC_SAMPLE at top). Self-guards on
  // sharedMemory/ctx existing, so installing immediately is safe.
  if (PC_SAMPLE) {
    try {
      await page.evaluate(() => {
        window.__pcSamp = { t0: performance.now(), segs: [], n: 0 };
        setInterval(() => {
          try {
            if (!window.sharedMemory) return;
            const A = new Uint32Array(window.sharedMemory.buffer);
            const c = A[0x0250002C >> 2] >>> 0;      // live ppc_state ctx ptr
            if (!c) return;
            const pc = A[c >> 2] >>> 0;
            if (!pc) return;
            const st = window.__pcSamp;
            const seg = Math.min(17, Math.floor((performance.now() - st.t0) / 10000));
            let sg = st.segs[seg];
            if (!sg) sg = st.segs[seg] = { hist: new Map(), gcmin: 0xFFFFFFFF, gcmax: 0, n: 0 };
            const m1 = A[0x02500020 >> 2] >>> 0;
            if (m1) {
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              const o = m1 + 0x1D3A54;               // GlobalCounter (guest BE)
              const gc = ((u8[o] << 24 | u8[o+1] << 16 | u8[o+2] << 8 | u8[o+3]) >>> 0);
              if (gc < sg.gcmin) sg.gcmin = gc;
              if (gc > sg.gcmax) sg.gcmax = gc;
            }
            const b = (pc & ~0xFF) >>> 0;
            sg.hist.set(b, (sg.hist.get(b) || 0) + 1);
            sg.n++; st.n++;
          } catch (_e) {}
        }, 2);
      });
      console.log('[probe] pc-sample: page-side guest-PC sampler installed');
    } catch (e) { console.error('[probe] pc-sample install failed: ' + e.message); }
  }
  // [MIPS meter v2] browser-side sampler: wrap-accumulate the executed-cycle cell
  // (0x026B3420, emitted += charge in the block prologue / fused back-edge) and
  // snapshot credited (global_timer mirror 0x02680008/0C). executed/credited ratio
  // makes phantom (idle-skip) credit a visible number. Steady window default 35s.
  try {
    await page.evaluate((winMs) => {
      window.__mips = { t0: performance.now(), winMs: winMs, execAccum: 0, execPrev: 0, winStart: null, last: null,
        traceN: 0, tracePrevCtr: 0, tracePrevFin: null, tracePeriod: 0, traceGap: 0, traceDecode: 0, tracePresent: 0 };
      setInterval(() => {
        try {
          if (!window.sharedMemory) return;
          const A = new Uint32Array(window.sharedMemory.buffer);
          const st = window.__mips;
          const lo = A[0x026B3420 >> 2] >>> 0;                 // executed cycles (u32 lo)
          let d = lo - st.execPrev; if (d < 0) d += 4294967296; // wrap-correct (<1 wrap/250ms even at 6x)
          st.execAccum += d; st.execPrev = lo;
          const cred = (A[0x026B3424 >> 2] >>> 0) + (A[0x026B3428 >> 2] >>> 0) * 4294967296; // credited (EmuThread global_timer mirror)
          const now = performance.now();
          const snap = { execAccum: st.execAccum, cred: cred, wall: now };
          st.last = snap;
          if (!st.winStart && (now - st.t0) >= st.winMs) st.winStart = snap;
          // [turnaround trace] on frame-counter (0x026B3448) advance: period = pe_finish
          // (0x026B3440 f64) delta; device_busy = summed RunFifo+Flush wall-time this
          // frame (0x026B3458 f64); idle = period - busy. Splits GPU-throughput vs guest-wait.
          const F = new Float64Array(window.sharedMemory.buffer);
          const ctr = A[0x026B3448 >> 2] >>> 0;
          if (ctr !== st.tracePrevCtr) {
            const fin = F[0x026B3440 >> 3], busy = F[0x026B3458 >> 3];
            st.lastFin = fin; st.lastBusy = busy; st.lastCtr = ctr;  // raw diag
            if (st.winStart && st.tracePrevFin != null &&
                fin > st.tracePrevFin && (fin - st.tracePrevFin) < 2000 && busy >= 0) {
              st.tracePeriod += fin - st.tracePrevFin;
              st.traceDecode += busy;                 // device busy (decode+flush)
              st.traceN++;
            }
            st.tracePrevFin = fin;
            st.tracePrevCtr = ctr;
          }
        } catch (_e) {}
      }, 100);
    }, (+process.env.MIPS_WINDOW_MS || 35000));
    console.log('[probe] mips-meter: executed/credited sampler installed (window '
      + (+process.env.MIPS_WINDOW_MS || 35000) + 'ms)');
  } catch (e) { console.error('[probe] mips-meter install failed: ' + e.message); }

  // ---- [guestclock] AI-DMA guest-clock witness + delivered-fps -------------
  // The GameCube analogue of the Dreamcast AICA witness. Cells published by
  // Core/HW/DSP.cpp::UpdateAudioDMA (see the [guest-clock witness] block there):
  //   0x026B3918 AID fires (DMA block wraps)     0x026B391C raw AI-DMA callbacks
  //   0x026B3920 callback period (ticks)         0x026B3924 CoreTiming ticks/sec
  //   0x026B3928 AudioDMAControl.NumBlocks
  // The callback is scheduled purely off global_timer, so callbacks/wall-second
  // divided by (ticks_hz / period) is the guest clock multiple — independent of
  // the JIT's cycle-charging, which is what [mips] measures.
  //
  // Piggy-backed here because it needs the same steady-state window: the live
  // SAB-present delivered-fps counters. 0x026B3518 is the SAB present frame
  // sequence (gamecube.html:3290 polls it to paint); its delta is frames
  // PUBLISHED, and counting distinct values seen from rAF is frames SHOWN.
  // 0x026B0930 is g_pe_setfinish_count (VideoCommon/PixelEngine.cpp:268) =
  // frames the GUEST finished. Restores a delivered-fps number on the live
  // path — the page's own '[rate] published=' only fires on the legacy
  // postMessage path (gamecube.html:3676, inside `case 'render':`).
  try {
    await page.evaluate((winMs) => {
      const st = window.__gclk = {
        t0: performance.now(), winMs: winMs, winStart: null, last: null,
        rafSeen: 0, rafPrevSeq: -1, rafWinSeen: null, err: null,
      };
      const snap = () => {
        const A = new Uint32Array(window.sharedMemory.buffer);
        const m1 = A[0x02500020 >> 2] >>> 0;
        // Guest big-endian u32 read through the MEM1 base, same helper the
        // phase sampler uses.
        const rd32 = (va) => {
          if (!m1) return 0;
          const u8 = new Uint8Array(window.sharedMemory.buffer);
          const o = m1 + (va & 0x01FFFFFF);
          return ((u8[o] << 24 | u8[o + 1] << 16 | u8[o + 2] << 8 | u8[o + 3]) >>> 0);
        };
        return {
          wall: performance.now(),
          aid: A[0x026B3918 >> 2] >>> 0,
          aidma: A[0x026B391C >> 2] >>> 0,
          period: A[0x026B3920 >> 2] >>> 0,
          ticksHz: A[0x026B3924 >> 2] >>> 0,
          numBlocks: A[0x026B3928 >> 2] >>> 0,
          presentSeq: Atomics.load(A, 0x026B3518 >> 2) >>> 0,
          peFrames: A[0x026B0930 >> 2] >>> 0,
          rafSeen: st.rafSeen,
          // MP4-only guest witnesses. GlobalCounter @0x801D3A54 is bumped once
          // per main-loop iteration (~/gc_refs/marioparty4/src/game/main.c:115);
          // retraceCount @0x801D4428 is VIGetRetraceCount's source, which ticks
          // once per VI field (~59.94/s on NTSC) regardless of the game's
          // minimumVcount gate (main.c:120-122). The RATIO of the two IS the
          // scene's vcount, so we never have to assume 60 vs 30 fps.
          globalCounter: rd32(0x801D3A54) >>> 0,
          retraceCount: rd32(0x801D4428) >>> 0,
        };
      };
      // rAF-side: count DISTINCT present sequence values = frames actually
      // presentable at display cadence (the "shown" half of delivered fps).
      const raf = () => {
        try {
          if (window.sharedMemory) {
            const A = new Uint32Array(window.sharedMemory.buffer);
            const s = Atomics.load(A, 0x026B3518 >> 2) >>> 0;
            // 0x026B3518 is a SEQLOCK, not a frame counter: WGPUGfx.cpp:1241-1263
            // bumps it to ODD before the pixel memcpy and to EVEN after. Only
            // even values are complete frames; odd means a write is in flight.
            if ((s & 1) === 0 && s !== st.rafPrevSeq) { st.rafPrevSeq = s; st.rafSeen++; }
          }
        } catch (_e) {}
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
      setInterval(() => {
        try {
          if (!window.sharedMemory) return;
          const s = snap();
          st.last = s;
          if (!st.winStart && (s.wall - st.t0) >= st.winMs) st.winStart = s;
        } catch (e) { st.err = String(e && e.message || e); }
      }, 100);
    }, (+process.env.MIPS_WINDOW_MS || 35000));
    console.log('[probe] guestclock: AI-DMA witness + delivered-fps sampler installed (window '
      + (+process.env.MIPS_WINDOW_MS || 35000) + 'ms)');
  } catch (e) { console.error('[probe] guestclock install failed: ' + e.message); }

  // ---- uncapped arm --------------------------------------------------------
  // PROBE_UNCAP_MS=<ms> arms CoreTiming's uncap cell 0x026B392C at that elapsed
  // time (CoreTiming.cpp:612-620: nonzero => IsSpeedUnlimited() returns true).
  // It must NOT be set during boot — Boot.cpp:305-311 / CoreTiming.cpp:609-611
  // record that a freed EmuThread during init starves MP4 at gc=0 — hence the
  // delay. Both meters are re-windowed at the flip so the measured window lies
  // entirely inside the uncapped regime, settling for PROBE_UNCAP_SETTLE_MS.
  const UNCAP_MS = parseInt(process.env.PROBE_UNCAP_MS || '0', 10);
  if (UNCAP_MS > 0) {
    const settleMs = parseInt(process.env.PROBE_UNCAP_SETTLE_MS || '8000', 10);
    setTimeout(async () => {
      try {
        const r = await page.evaluate((settle) => {
          if (!window.sharedMemory) return 'no sharedMemory';
          const A = new Uint32Array(window.sharedMemory.buffer);
          const before = A[0x026B392C >> 2] >>> 0;
          A[0x026B392C >> 2] = 1;
          const after = A[0x026B392C >> 2] >>> 0;
          const now = performance.now();
          for (const st of [window.__mips, window.__gclk]) {
            if (!st) continue;
            // Preserve the pre-flip window so ONE process yields BOTH arms under
            // the SAME machine load — an A/B across separate runs is worthless
            // here, the box drifts 0.51x..0.99x with other agents' load alone.
            st.preUncap = st.winStart ? { start: st.winStart, end: st.last } : null;
            st.t0 = now; st.winMs = settle; st.winStart = null;
            if ('execAccum' in st) st.execAccum = 0;   // mips accumulator restart
          }
          return 'cell 0x026B392C ' + before + ' -> ' + after
            + '; pre-uncap window ' + (window.__gclk && window.__gclk.preUncap ? 'CAPTURED' : 'absent');
        }, settleMs);
        console.log('[uncap] armed at t=' + (UNCAP_MS / 1000).toFixed(1) + 's: ' + r
          + '; meters re-windowed (settle ' + settleMs + 'ms)');
      } catch (e) { console.error('[uncap] arm failed: ' + e.message); }
    }, UNCAP_MS);
  } else {
    console.log('[uncap] not armed (default THROTTLED arm; set PROBE_UNCAP_MS to arm)');
  }

  // ---- [vtx A/B 2026-08-29] SAME-PROCESS interleaved vertex-loader pair -----
  // PROBE_VTX_AB_MS=<ms> alternates SAB cell 0x026B3900 (0 = emitted wasm vertex
  // loader, 1 = stock scalar software loader) every <ms>, sampling the page's own
  // rate model once a second and tagging each sample with the arm that was live.
  //
  // Why interleave in ONE process instead of running two probes: this box sits at
  // load 28-97 with other agents' probes on it, and gate #10 voids any pair taken
  // above ~25. Two 90s runs straddle minutes of drifting load and are worthless.
  // Alternating every few seconds puts both arms under the SAME load, the SAME
  // scene, and the SAME warmed pipeline cache, so the RATIO survives what the
  // absolute numbers cannot. VertexLoaderWasm::RunVertices re-reads the cell per
  // DRAW, so the flip takes effect immediately with no reload and no re-boot.
  //
  // The sample straddling each flip is discarded: the page's cap model is a 1s
  // window (gamecube.html:606 m.sample), so the window containing a flip contains
  // both arms and belongs to neither.
  const VTX_AB_MS = parseInt(process.env.PROBE_VTX_AB_MS || '0', 10);
  if (VTX_AB_MS > 0) {
    const startMs = parseInt(process.env.PROBE_VTX_AB_START_MS || '30000', 10);
    setTimeout(async () => {
      try {
        await page.evaluate((periodMs) => {
          if (!window.sharedMemory) return;
          const A = new Uint32Array(window.sharedMemory.buffer);
          const st = { rows: [], arm: 0, flippedAt: 0, armed: false, builtAtArm: 0 };
          window.__vtxAB = st;
          // MUST hold arm A (cell 0) until every vertex format has been created.
          // VertexLoaderManager CACHES loaders, and CreateVertexLoader returns a
          // plain VertexLoader immediately when the force-software cell is set —
          // so a format first drawn while the cell is 1 is stuck as a software
          // loader for the whole run and stops honouring the cell entirely.
          // Flipping too early produced a bogus 0.993x "no speedup" with
          // vtxBuilt=0/vtxUnsup=0, i.e. BOTH arms running the same software code.
          A[0x026B3900 >> 2] = 0;
          const built = () => A[0x026B3994 >> 2] >>> 0;
          const creates = () => A[0x026B3990 >> 2] >>> 0;
          let stableFor = 0, lastCreates = -1;
          const warm = setInterval(() => {
            const c = creates();
            stableFor = (c === lastCreates && c > 0) ? stableFor + 1 : 0;
            lastCreates = c;
            // Formats stop appearing and at least one wasm loader exists.
            if (!(stableFor >= 5 && built() > 0)) return;
            clearInterval(warm);
            st.armed = true;
            st.builtAtArm = built();
            st.flippedAt = performance.now();
            setInterval(() => {
              st.arm ^= 1;
              A[0x026B3900 >> 2] = st.arm;
              st.flippedAt = performance.now();
            }, periodMs);
          }, 1000);
          setInterval(() => {
            try {
              const R = window.__gcRate;
              if (!R || !st.armed) return;
              const now = performance.now();
              // Drop the window containing a flip — it saw both arms.
              if (now - st.flippedAt < 1100) return;
              st.rows.push({ arm: A[0x026B3900 >> 2] >>> 0, rcap: R.renderCap,
                             gcap: R.guestCap, cap: R.capFps, speed: R.speed,
                             emit: A[0x026B3980 >> 2] >>> 0, fall: A[0x026B3984 >> 2] >>> 0,
                             built: built() });
            } catch (_e) {}
          }, 1000);
        }, VTX_AB_MS);
        console.log('[vtxAB] interleaving every ' + VTX_AB_MS + 'ms from t=' + startMs + 'ms');
      } catch (e) { console.error('[vtxAB] arm failed: ' + e.message); }
    }, startMs);
  }

  // ---- [render-stage split 2026-08-29] ------------------------------------
  // PROBE_STAGE_SPLIT=<periodMs> turns on the BemStageTimer regions
  // (VideoCommon/BemStageTimer.h, enable cell 0x026B3BDC) and prints ONE line per
  // [CELL COLLISION FIX 2026-09-01] This cell was 0x026B3B20, which is the FIFO
  // backpressure brake's KILL SWITCH (CommandProcessor.cpp BemFifoBackpressure,
  // "nonzero = brake DISABLED"). So every PROBE_STAGE_SPLIT run silently
  // DISABLED the PSO FIFO wedge brake while measuring — the wedge the brake
  // exists to prevent was re-armed by the act of profiling. Any stage-split
  // result taken before this date ran with the brake OFF.
  // window with the DELTA of every stage accumulator, so _recomp_render_fifo is
  // attributed to opcode decode / BP+XF register writes / vertex load / texture
  // cache / constants / pipeline / WGPU submission instead of one 15 ms bar.
  //
  // Layout published by the C++ once per _recomp_render_fifo:
  //   0x026B3B40  11 x f64 accumulated ms  (indices 0..10 below)
  //   0x026B3B98  17 x u32 call counts     (0..10 timed, 11..16 census)
  //     0 vtx  1 tex  2 const  3 pipe  4 draw  5 flush  6 fifo  7 tpair
  //     8 peek  9 bp  10 xf | 11 nBP 12 nXF 13 nCP 14 nIdx 15 nDL 16 FRAMES
  // kFlush is a SUPERSET of tex/const/pipe/draw; kFifoTotal is a superset of all.
  // decode/other = fifo - flush - vtx - peek - bp - xf = the opcode WALK itself
  // (Run()'s dispatch, CP reg writes, RefreshLoader/GetVertexSize, DL recursion).
  //
  // TIMER COST IS MEASURED. kTimerPair times 64 back-to-back clock reads once per
  // frame, so `tcall` is the per-read cost in-situ. `cor:` is the same split with
  // (reads-inside-region x tcall) subtracted from every region — a Scope costs 2
  // reads and the enclosing region absorbs both. The corrected column is the one
  // to quote for SHARES; the ablation matched pair (PROBE_AB, below) is the
  // arbiter for magnitude because it carries no timer cost at all.
  //
  // PROBE_STAGE_SPLIT_START_MS delays arming (default 30000). Slot 16 (frames) is
  // always live, so the census works with the timers still off.
  if (process.env.PROBE_STAGE_SPLIT) {
    const _ssPer = parseInt(process.env.PROBE_STAGE_SPLIT, 10) || 5000;
    const _ssStart = parseInt(process.env.PROBE_STAGE_SPLIT_START_MS || '30000', 10);
    const _ssRows = [];
    let _ssPrev = null;
    setTimeout(async () => {
      try {
        await page.evaluate(() => {
          if (window.sharedMemory) new Uint32Array(window.sharedMemory.buffer)[0x026B3BDC >> 2] = 1;
        });
        console.log('[stage-split] timers ARMED (cell 0x026B3BDC=1) at t=' + _ssStart + 'ms');
      } catch (e) { console.log('[stage-split] arm failed: ' + e.message); }
    }, _ssStart);
    const _ssTimer = setInterval(async () => {
      try {
        const s = await page.evaluate(() => {
          if (!window.sharedMemory) return null;
          const F = new Float64Array(window.sharedMemory.buffer);
          const A = new Uint32Array(window.sharedMemory.buffer);
          const o = { t: performance.now(), ms: [], n: [] };
          for (let i = 0; i < 11; i++) o.ms.push(F[(0x026B3B40 >> 3) + i]);
          for (let i = 0; i < 17; i++) o.n.push(A[(0x026B3B98 >> 2) + i] >>> 0);
          o.submits = A[0x026B3938 >> 2] >>> 0;   // [census 2026-08-29] WGPUGfx::SubmitFrame
          o.upbytes = A[0x026B393C >> 2] >>> 0;   // [census] vtx+idx bytes to writeBuffer
          o.rate = window.__gcRate
            ? { rcap: window.__gcRate.renderCap, gcap: window.__gcRate.guestCap,
                speed: window.__gcRate.speed } : null;
          return o;
        });
        if (!s) return;
        if (_ssPrev && s.n[16] > _ssPrev.n[16] && s.n[6] > _ssPrev.n[6]) {
          const F = s.n[6] - _ssPrev.n[6];                       // TIMED frames
          const dn = (i) => s.n[i] - _ssPrev.n[i];
          const d = (i) => (s.ms[i] - _ssPrev.ms[i]) / F;        // ms per timed frame
          const cpf = (i) => dn(i) / F;                          // calls per timed frame
          // per-read cost: Calibrate() already divides by (kCalReads-1)
          const tcall = dn(7) > 0 ? (s.ms[7] - _ssPrev.ms[7]) / dn(7) : 0;
          // Reads charged INSIDE each region. Every Scope = 2 reads; the enclosing
          // region absorbs both, the region itself absorbs only its own closing read.
          const leaf = [0, 1, 2, 3, 4, 8, 9, 10];
          const inside = {};
          leaf.forEach((i) => { inside[i] = dn(i); });
          inside[5] = dn(5) + 2 * (dn(1) + dn(2) + dn(3) + dn(4));
          inside[6] = dn(6) + 2 * (dn(0) + dn(1) + dn(2) + dn(3) + dn(4) + dn(5)
                                   + dn(8) + dn(9) + dn(10)) + 64 * dn(7);
          const cor = (i) => d(i) - tcall * inside[i] / F;
          const rawOther = d(6) - d(5) - d(0) - d(8) - d(9) - d(10);
          const corOther = cor(6) - cor(5) - cor(0) - cor(8) - cor(9) - cor(10);
          const corFlushOther = cor(5) - cor(1) - cor(2) - cor(3) - cor(4);
          const ovh = tcall * inside[6] / F;
          const row = { tsec: +(s.t / 1000).toFixed(1), frames: F,
            drawsPerFrame: +(cpf(4)).toFixed(1), vtxPerFrame: +(cpf(0)).toFixed(1),
            nBP: +(dn(11) / F).toFixed(0), nXF: +(dn(12) / F).toFixed(0),
            nCP: +(dn(13) / F).toFixed(0), nIdx: +(dn(14) / F).toFixed(0),
            nDL: +(dn(15) / F).toFixed(0),
            raw: { fifo: +d(6).toFixed(3), vtx: +d(0).toFixed(3), tex: +d(1).toFixed(3),
                   konst: +d(2).toFixed(3), pipe: +d(3).toFixed(3), draw: +d(4).toFixed(3),
                   flush: +d(5).toFixed(3), peek: +d(8).toFixed(3), bp: +d(9).toFixed(3),
                   xf: +d(10).toFixed(3), other: +rawOther.toFixed(3) },
            cor: { fifo: +cor(6).toFixed(3), vtx: +cor(0).toFixed(3), tex: +cor(1).toFixed(3),
                   konst: +cor(2).toFixed(3), pipe: +cor(3).toFixed(3), draw: +cor(4).toFixed(3),
                   flush: +cor(5).toFixed(3), peek: +cor(8).toFixed(3), bp: +cor(9).toFixed(3),
                   xf: +cor(10).toFixed(3), other: +corOther.toFixed(3),
                   flushOther: +corFlushOther.toFixed(3) },
            tcallUs: +(tcall * 1000).toFixed(4), ovhMs: +ovh.toFixed(3),
            rate: s.rate || null };
          _ssRows.push(row);
          const T = cor(6);
          const pct = (v) => T > 0 ? (100 * v / T).toFixed(1) + '%' : '--';
          console.log('[stage-split] t=' + row.tsec + 's f=' + F
            + ' draws/f=' + row.drawsPerFrame + ' vtx/f=' + row.vtxPerFrame
            + '  RAW fifo=' + row.raw.fifo + 'ms  tcall=' + row.tcallUs + 'us ovh=' + row.ovhMs + 'ms'
            + '  ||  COR fifo=' + row.cor.fifo + 'ms'
            + ' | draw=' + row.cor.draw + '(' + pct(cor(4)) + ')'
            + ' walk=' + row.cor.other + '(' + pct(corOther) + ')'
            + ' vtx=' + row.cor.vtx + '(' + pct(cor(0)) + ')'
            + ' tex=' + row.cor.tex + '(' + pct(cor(1)) + ')'
            + ' bp=' + row.cor.bp + '(' + pct(cor(9)) + ')'
            + ' xf=' + row.cor.xf + '(' + pct(cor(10)) + ')'
            + ' const=' + row.cor.konst + '(' + pct(cor(2)) + ')'
            + ' pipe=' + row.cor.pipe + '(' + pct(cor(3)) + ')'
            + ' peek=' + row.cor.peek + '(' + pct(cor(8)) + ')'
            + ' flushOther=' + row.cor.flushOther + '(' + pct(corFlushOther) + ')'
            + ' | opc/f: BP=' + row.nBP + ' XF=' + row.nXF + ' CP=' + row.nCP
            + ' IDX=' + row.nIdx + ' DL=' + row.nDL
            + ' | submits/f=' + (((s.submits - _ssPrev.submits) / F) || 0).toFixed(1)
            + ' upKB/f=' + ((((s.upbytes >>> 0) - (_ssPrev.upbytes >>> 0)) / F) / 1024).toFixed(1)
            + (s.rate ? ('  [rcap=' + (s.rate.rcap == null ? '--' : (+s.rate.rcap).toFixed(1))
                        + ' gcap=' + (s.rate.gcap == null ? '--' : (+s.rate.gcap).toFixed(1)) + ']') : ''));
        }
        _ssPrev = s;
      } catch (_e) {}
    }, _ssPer);
    _ssTimer.unref && _ssTimer.unref();
    global.__ssRows = _ssRows;
    if (process.env.PROBE_STAGE_SPLIT_JSON) {
      process.on('exit', () => {
        try { fs.writeFileSync(process.env.PROBE_STAGE_SPLIT_JSON, JSON.stringify(_ssRows, null, 1)); }
        catch (_e) {}
      });
    }
    console.log('[probe] stage-split: per-' + _ssPer + 'ms render-stage series installed');
  }

  // ---- [generic ablation A/B 2026-08-29] ----------------------------------
  // PROBE_AB=<cell hex> alternates ONE SAB cell between 0 and 1 every
  // PROBE_AB_MS, in ONE process, so both arms see the same load, the same scene
  // and the same warmed pipeline/texture cache. That is what made the vertex
  // loader ratio reproducible to 0.2% while a naive two-run A/B on this box
  // (load 25-98, five sibling Chromes) produced a false 0.993x null.
  //
  // Three rules this rig enforces, each paid for with a wrong answer today:
  //   1. A NULL IS NOT A RESULT UNTIL THE ARMS ARE PROVEN TO DIFFER.
  //      PROBE_AB_HITCELL names a counter that ONLY the ablated arm can advance.
  //      If arm 1 does not advance it, or arm 0 does, the ratio is REFUSED.
  //      (VertexLoaderManager caches loaders and stops honouring its cell; and a
  //      whole fusion campaign A/B'd two identical configs because the path was
  //      dead code at block_cache.cpp:233.)
  //   2. THE SCENE MUST MATCH. MP4's attract loop alternates a 1300-draw board
  //      frame with 1-2 draw frames; blending them makes any ratio meaningless.
  //      PROBE_AB_DRAWS_MIN/MAX gate each window on measured draws-per-frame
  //      (BemStageTimer slot 4 vs slot 16 — both live with timers off).
  //   3. renderCap AND guestCap ARE REPORTED SEPARATELY. `cap` is min() of the
  //      two, so a single number cannot be compared across arms.
  // The window straddling a flip is discarded: the page's cap model is a 1 s
  // window (gamecube.html:606), so it belongs to neither arm.
  if (process.env.PROBE_AB) {
    const _abCell = parseInt(process.env.PROBE_AB, 16) || parseInt(process.env.PROBE_AB, 10);
    const _abHit = process.env.PROBE_AB_HITCELL
      ? (parseInt(process.env.PROBE_AB_HITCELL, 16) || parseInt(process.env.PROBE_AB_HITCELL, 10)) : 0;
    const _abMs = parseInt(process.env.PROBE_AB_MS || '6000', 10);
    const _abStart = parseInt(process.env.PROBE_AB_START_MS || '45000', 10);
    const _abMin = parseFloat(process.env.PROBE_AB_DRAWS_MIN || '0');
    const _abMax = parseFloat(process.env.PROBE_AB_DRAWS_MAX || '1e9');
    const _abName = process.env.PROBE_AB_NAME || ('cell' + process.env.PROBE_AB);
    setTimeout(async () => {
      try {
        await page.evaluate((cell, hit, periodMs) => {
          if (!window.sharedMemory) return;
          const A = new Uint32Array(window.sharedMemory.buffer);
          const st = { rows: [], arm: 0, flippedAt: performance.now(), prev: null };
          window.__abRig = st;
          A[cell >> 2] = 0;
          setInterval(() => { st.arm ^= 1; A[cell >> 2] = st.arm; st.flippedAt = performance.now(); },
                      periodMs);
          setInterval(() => {
            try {
              const now = performance.now();
              const cur = { t: now, frames: A[(0x026B3B98 >> 2) + 16] >>> 0,
                            draws: A[0x026B289C >> 2] >>> 0,
                            hit: hit ? (A[hit >> 2] >>> 0) : 0 };
              const p = st.prev; st.prev = cur;
              if (!p || now - st.flippedAt < 1100) return;
              const df = cur.frames - p.frames;
              if (df <= 0) return;
              const R = window.__gcRate; if (!R) return;
              st.rows.push({ arm: A[cell >> 2] >>> 0, rcap: R.renderCap, gcap: R.guestCap,
                             cap: R.capFps, speed: R.speed,
                             dpf: (cur.draws - p.draws) / df, frames: df,
                             dhit: cur.hit - p.hit });
            } catch (_e) {}
          }, 1000);
        }, _abCell, _abHit, _abMs);
        console.log('[ab:' + _abName + '] interleaving cell 0x' + _abCell.toString(16)
          + ' every ' + _abMs + 'ms from t=' + _abStart + 'ms'
          + (_abHit ? ('; validity counter 0x' + _abHit.toString(16)) : '; NO validity counter'));
      } catch (e) { console.error('[ab:' + _abName + '] arm failed: ' + e.message); }
    }, _abStart);
    global.__abReport = async () => {
      try {
        const rows = await page.evaluate(() => (window.__abRig ? window.__abRig.rows : []));
        const kept = rows.filter((r) => r.dpf >= _abMin && r.dpf <= _abMax && r.rcap != null);
        const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y);
          return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };
        const out = {};
        [0, 1].forEach((arm) => {
          const A = kept.filter((r) => r.arm === arm);
          out[arm] = { n: A.length, rcap: med(A.map((r) => r.rcap)),
                       gcap: med(A.map((r) => r.gcap).filter((v) => v != null)),
                       speed: med(A.map((r) => r.speed).filter((v) => v != null)),
                       dpf: med(A.map((r) => r.dpf)),
                       hit: A.reduce((s, r) => s + r.dhit, 0) };
        });
        console.log('[ab:' + _abName + '] rows=' + rows.length + ' kept=' + kept.length
          + ' (draws/frame gate ' + _abMin + '..' + _abMax + ')');
        [0, 1].forEach((arm) => {
          const o = out[arm];
          console.log('[ab:' + _abName + '] arm' + arm + (arm ? ' (ABLATED)' : ' (baseline)')
            + ' n=' + o.n + ' renderCap=' + (o.rcap == null ? '--' : o.rcap.toFixed(2))
            + ' guestCap=' + (o.gcap == null ? '--' : o.gcap.toFixed(2))
            + ' speed=' + (o.speed == null ? '--' : o.speed.toFixed(3))
            + ' draws/f=' + (o.dpf == null ? '--' : o.dpf.toFixed(0))
            + ' hitDelta=' + o.hit);
        });
        const valid = !_abHit ? false : (out[1].hit > 0 && out[0].hit === 0);
        console.log('[ab:' + _abName + '] VALIDITY: ' + (valid ? 'PASS — only the ablated arm advanced 0x'
          + _abHit.toString(16) : 'FAIL — arms NOT proven to differ (arm0 hit=' + out[0].hit
          + ', arm1 hit=' + out[1].hit + '); ratio SUPPRESSED'));
        if (valid && out[0].rcap && out[1].rcap && out[0].n >= 3 && out[1].n >= 3) {
          const msA = 1000 / out[0].rcap, msB = 1000 / out[1].rcap;
          console.log('[ab:' + _abName + '] renderCap ablated/baseline = '
            + (out[1].rcap / out[0].rcap).toFixed(3) + 'x   =>  removed component ~ '
            + (msA - msB).toFixed(2) + ' ms/frame of ' + msA.toFixed(2)
            + ' ms  (' + (100 * (msA - msB) / msA).toFixed(1) + '% of the render stage)');
        }
        return out;
      } catch (e) { console.log('[ab:' + _abName + '] report failed: ' + e.message); return null; }
    };
  }

  // ---- [scene-rate 2026-08-28] PER-WINDOW rate time series -----------------
  // PROBE_SCENE_RATE=<periodMs> prints ONE line per window so a rate can be
  // attributed to the SCENE that was on screen for that window, instead of a
  // single whole-run average that blends boot + title + menu + gameplay into a
  // number that describes none of them. Read-only: samples cells other code
  // already publishes.
  //
  //   speed   = Δcredited-cycles / 486e6 / Δwall. CoreTiming's global_timer is
  //             emulated time (CoreTiming.cpp:406 mirrors it to 0x026B3424/28),
  //             so this is literally emulated-time/wall-time. 1.00x = hardware.
  //   exec    = Δ0x026B3420 (cycles the JIT actually EXECUTED). credited-exec =
  //             idle-skip phantom credit.
  //   drawn   = Δ PE SetFinish (0x026B0930) — frames the GPU finished DRAWING,
  //             i.e. the game's own frame rate under emulation.
  //   pub     = Δ WGPU publish seq (0x026B3518) / 2 (WGPUGfx bumps +1 at write
  //             begin and +1 at write end) — frames handed to the page.
  //   gc      = MP4's guest GlobalCounter at 0x801D3A54 — a GUEST-VISIBLE clock,
  //             used to cross-check `speed` on MP4 (the [mips] meter has never
  //             been validated; see commit 50fb213).
  //   rate.*  = the page's own rate model (window.__gcRate), which is the only
  //             speed witness on the recomp path.
  if (process.env.PROBE_SCENE_RATE) {
    const _srPer = parseInt(process.env.PROBE_SCENE_RATE, 10) || 5000;
    let _srPrev = null;
    const _srRows = [];
    const _srTimer = setInterval(async () => {
      try {
        const s = await page.evaluate(() => {
          const o = { t: performance.now() };
          try {
            if (window.sharedMemory) {
              const A = new Uint32Array(window.sharedMemory.buffer);
              const F = new Float64Array(window.sharedMemory.buffer);
              o.cred = (A[0x026B3424 >> 2] >>> 0) + (A[0x026B3428 >> 2] >>> 0) * 4294967296;
              o.exec = A[0x026B3420 >> 2] >>> 0;
              o.pe   = A[0x026B0930 >> 2] >>> 0;
              o.pub  = A[0x026B3518 >> 2] >>> 0;
              o.fctr = A[0x026B3448 >> 2] >>> 0;
              o.busy = F[0x026B3458 >> 3];
              // [D1 2026-08-29] FIFO-backpressure discriminator (78372b6 D1).
              // rgl = RunGpuLoop drain-loop body iterations, written at
              // Fifo.cpp:402 INSIDE the `while (!IsInterruptWaiting() && ...)`
              // loop. Climbing while `drawn` (PE SetFinish) is frozen => the
              // decoder is consuming a desynced stream. Frozen => the
              // Fifo.cpp:397 guard is false, i.e. a watermark stall.
              // NOTE its nine sibling cells (0x026B1AD0/1AD8/1AE4../1B10) have
              // no writer left in the source and read dead zeros — not evidence.
              o.rgl  = A[0x026B1AD4 >> 2] >>> 0;
              // [fifo-backpressure 2026-08-29] host-side GXOverflowHandler witness
              // (CommandProcessor.cpp BemFifoBackpressure): engages/bails/ms/maxdist.
              o.bpN  = A[0x026B3B10 >> 2] >>> 0;
              o.bpBail = A[0x026B3B14 >> 2] >>> 0;
              o.bpMs = A[0x026B3B18 >> 2] >>> 0;
              o.bpMax = A[0x026B3B1C >> 2] >>> 0;
              o.xpc  = (() => { const c = A[0x0250002C >> 2] >>> 0;
                return c ? (A[c >> 2] >>> 0).toString(16) : '0'; })();
              const m1 = A[0x02500020 >> 2] >>> 0;
              if (m1) {
                const u8 = new Uint8Array(window.sharedMemory.buffer);
                const g = m1 + 0x1D3A54;
                o.gc = ((u8[g] << 24 | u8[g + 1] << 16 | u8[g + 2] << 8 | u8[g + 3]) >>> 0);
              }
            }
          } catch (_e) {}
          try {
            const R = window.__gcRate;
            if (R) o.rate = { path: R.path, speed: R.speed, cap: R.capFps,
                              // cap is min(guestCap, renderCap) on the recomp path. Capture
                              // BOTH terms: a cap number without its binding stage cannot be
                              // compared across arms (a freerun arm is render-bound, a
                              // hardware-rate arm is usually guest-bound).
                              gcap: R.guestCap, rcap: R.renderCap,
                              pub: R.published, shown: R.shown, starved: R.starved,
                              nativeHz: R.nativeHz, uncapped: R.uncapped };
            const _f = document.getElementById('fps');
            if (_f) o.head = _f.textContent;
          } catch (_e) {}
          return o;
        });
        if (!s) return;
        if (_srPrev) {
          const dw = (s.t - _srPrev.t) / 1000;
          if (dw > 0) {
            const dcred = (s.cred || 0) - (_srPrev.cred || 0);
            let dexec = (s.exec >>> 0) - (_srPrev.exec >>> 0); if (dexec < 0) dexec += 4294967296;
            const dpe  = (s.pe || 0)  - (_srPrev.pe || 0);
            const dpub = ((s.pub || 0) - (_srPrev.pub || 0)) / 2;
            let drgl = (s.rgl >>> 0) - (_srPrev.rgl >>> 0); if (drgl < 0) drgl += 4294967296;
            let dgc = (s.gc != null && _srPrev.gc != null) ? (s.gc - _srPrev.gc) : null;
            const speed = dcred / 486e6 / dw;
            const row = { tsec: +(s.t / 1000).toFixed(1), dw: +dw.toFixed(2),
              speed: +speed.toFixed(3), execMHz: +(dexec / dw / 1e6).toFixed(1),
              credMHz: +(dcred / dw / 1e6).toFixed(1),
              drawn: +(dpe / dw).toFixed(1), pub: +(dpub / dw).toFixed(1),
              gcps: dgc == null ? null : +(dgc / dw).toFixed(1),
              rgl: +(drgl / dw).toFixed(0), xpc: s.xpc || null,
              bpN: s.bpN || 0, bpBail: s.bpBail || 0, bpMs: s.bpMs || 0, bpMax: s.bpMax || 0,
              bpDn: (s.bpN || 0) - (_srPrev.bpN || 0), bpDms: (s.bpMs || 0) - (_srPrev.bpMs || 0),
              rate: s.rate || null };
            row.head = s.head || null;
            _srRows.push(row);
            if (s.head) console.log('[page-headline] t=' + row.tsec + 's  "' + s.head + '"');
            console.log('[scene-rate] t=' + row.tsec + 's  speed=' + row.speed.toFixed(3)
              + 'x  cred=' + row.credMHz + 'MHz exec=' + row.execMHz + 'MHz'
              + '  drawn=' + row.drawn + '/s  published=' + row.pub + '/s'
              + '  rglDrain=' + row.rgl + '/s  xpc=0x' + (row.xpc || '?')
              + '  brake=' + row.bpDn + '/w(' + row.bpN + ' tot, ' + row.bpDms + 'ms/w, bail '
              + row.bpBail + ', maxDist ' + row.bpMax + ')'
              + (row.gcps == null ? '' : '  guestGC=' + row.gcps + '/s')
              + (s.rate ? ('  [page ' + s.rate.path + ' speed='
                  + (s.rate.speed == null ? '--' : (+s.rate.speed).toFixed(3) + 'x')
                  + ' cap=' + (s.rate.cap == null ? '--' : (+s.rate.cap).toFixed(0))
                  + ' (g=' + (s.rate.gcap == null ? '--' : (+s.rate.gcap).toFixed(0))
                  + ' r=' + (s.rate.rcap == null ? '--' : (+s.rate.rcap).toFixed(0)) + ')'
                  + ' shown=' + (+(s.rate.shown || 0)).toFixed(0)
                  + '/pub=' + (+(s.rate.pub || 0)).toFixed(0) + ']') : ''));
          }
        }
        _srPrev = s;
      } catch (_e) {}
    }, _srPer);
    _srTimer.unref && _srTimer.unref();
    global.__srRows = _srRows;
    if (process.env.PROBE_SCENE_RATE_JSON) {
      process.on('exit', () => {
        try { fs.writeFileSync(process.env.PROBE_SCENE_RATE_JSON, JSON.stringify(_srRows, null, 1)); }
        catch (_e) {}
      });
    }
    console.log('[probe] scene-rate: per-' + _srPer + 'ms rate series installed');
  }

  // ---- [flush-census 2026-08-29] read the VertexManagerBase census cells ----
  // PROBE_FLUSH_CENSUS="<ms>,<ms>" (offsets from the Start click, same frame as
  // PROBE_LOAD_STATE_MS) dumps cells 0x026B3A00..0x026B3AF4, which
  // VertexManagerBase.cpp's BemFlushCensus namespace publishes. Counters are
  // CUMULATIVE FROM BOOT, so two samples are required and the DELTA is the
  // answer; a single sample is dominated by the boot/attract traffic.
  //
  // PROBE_CENSUS_OFF_MS=<ms> writes 1 to the control cell 0x026B3A00 at that
  // offset (nonzero = census OFF, BemFlushCensus::Enabled()), which is the
  // is-the-census-itself-perturbing arm — compare drawPath[0] / peFrames rates
  // either side of the flip inside ONE process.
  const CENSUS_BASE = 0x026B3A00;
  const CENSUS_WORDS = 62;  // 0x026B3A00..0x026B3AF4 inclusive
  const CAT_NAMES = ['TEX', 'TEV', 'BLEND', 'TEVREG', 'SCISSOR', 'PECOPY',
                     'MISC', 'PROJ', 'POSMTX', 'LIGHT', 'TEXGEN', 'VTXFMT'];
  const censusSnap = async (tag) => {
    const s = await page.evaluate((base, words) => {
      if (!window.sharedMemory) return null;
      const A = new Uint32Array(window.sharedMemory.buffer);
      const o = { wall: performance.now(), c: [] };
      for (let i = 0; i < words; i++) o.c.push(A[(base >> 2) + i] >>> 0);
      // co-sampled so the census delta can be normalised against the same
      // window's real work: drawPath[0] = DrawIndexed entries, peFrames = PE
      // SetFinish (guest frames).
      o.drawPath0 = A[0x026B3560 >> 2] >>> 0;
      o.peFrames = A[0x026B0930 >> 2] >>> 0;
      return o;
    }, CENSUS_BASE, CENSUS_WORDS);
    if (!s) { console.log('[census] ' + tag + ': no sharedMemory'); return null; }
    const c = s.c;
    const F = {
      ctl: c[0], calls: c[1], noop: c[2], real: c[3], drawn: c[4],
      cullAll: c[5], zeroIdx: c[6], sitePrim: c[7], siteBuf: c[8], siteExt: c[9],
      cats: c.slice(10, 22),
      maskNone: c[22], maskOne: c[23], bitsSum: c[24], idxSum: c[25],
      slots: [], slotOvf: c[58], frames: c[59], drawnAtF: c[60], drawnDelta: c[61],
      drawPath0: s.drawPath0, peFrames: s.peFrames, wall: s.wall,
    };
    for (let i = 0; i < 16; i++) F.slots.push({ key: c[26 + i * 2], count: c[27 + i * 2] });
    console.log('[census] ' + tag + ' t=' + (s.wall / 1000).toFixed(1) + 's'
      + ' ctl=' + F.ctl + ' calls=' + F.calls + ' noop=' + F.noop + ' real=' + F.real
      + ' drawn=' + F.drawn + ' cullAll=' + F.cullAll + ' zeroIdx=' + F.zeroIdx
      + ' | site prim=' + F.sitePrim + ' buf=' + F.siteBuf + ' ext=' + F.siteExt
      + ' | maskNone=' + F.maskNone + ' maskOne=' + F.maskOne + ' bitsSum=' + F.bitsSum
      + ' idxSum=' + F.idxSum + ' slotOvf=' + F.slotOvf
      + ' | frames=' + F.frames + ' drawnDelta=' + F.drawnDelta
      + ' | drawPath0=' + F.drawPath0 + ' peFrames=' + F.peFrames);
    console.log('[census] ' + tag + ' cats ' + F.cats.map((v, i) => CAT_NAMES[i] + '=' + v).join(' '));
    return F;
  };
  const maskStr = (m) => {
    if (m === 0) return 'none';
    const out = [];
    for (let i = 0; i < 12; i++) if (m & (1 << i)) out.push(CAT_NAMES[i]);
    return out.join('|');
  };
  const SITE_NAME = { 0: 'ext', 1: 'prim', 2: 'buf' };
  const censusDelta = (a, b) => {
    if (!a || !b) { console.log('[census-delta] missing a sample — nothing to subtract'); return; }
    const dw = (b.wall - a.wall) / 1000;
    const d = (k) => (b[k] >>> 0) - (a[k] >>> 0);
    const dDrawn = d('drawn'), dCalls = d('calls'), dReal = d('real'), dNoop = d('noop');
    const dBits = d('bitsSum'), dIdx = d('idxSum');
    const dCats = b.cats.map((v, i) => (v >>> 0) - (a.cats[i] >>> 0));
    const catTotal = dCats.reduce((x, y) => x + y, 0);
    console.log('[census-delta] window=' + dw.toFixed(2) + 's'
      + '  calls=' + dCalls + ' (' + (dCalls / dw).toFixed(0) + '/s)'
      + '  noop=' + dNoop + '  real=' + dReal + '  drawn=' + dDrawn
      + ' (' + (dDrawn / dw).toFixed(0) + '/s)'
      + '  cullAll=' + d('cullAll') + '  zeroIdx=' + d('zeroIdx'));
    console.log('[census-delta] sites  prim=' + d('sitePrim') + '  buf=' + d('siteBuf')
      + '  ext=' + d('siteExt')
      + '   | drawPath0 +' + d('drawPath0') + '   peFrames +' + d('peFrames')
      + '   frames +' + d('frames')
      + '   drawn/peFrame=' + (d('peFrames') ? (dDrawn / d('peFrames')).toFixed(1) : 'n/a'));
    console.log('[census-delta] maskNone=' + d('maskNone')
      + ' (' + (dDrawn ? (100 * d('maskNone') / dDrawn).toFixed(1) : '0') + '% of drawn)'
      + '  maskOne=' + d('maskOne')
      + ' (' + (dDrawn ? (100 * d('maskOne') / dDrawn).toFixed(1) : '0') + '%)'
      + '  bits/flush=' + (dDrawn ? (dBits / dDrawn).toFixed(3) : 'n/a')
      + '  indices/drawn=' + (dDrawn ? (dIdx / dDrawn).toFixed(2) : 'n/a'));
    const ranked = dCats.map((v, i) => ({ n: CAT_NAMES[i], v }))
      .sort((x, y) => y.v - x.v);
    console.log('[census-delta] cats (marginal, sum=' + catTotal + '): '
      + ranked.map(r => r.n + '=' + r.v
          + '(' + (dDrawn ? (100 * r.v / dDrawn).toFixed(1) : '0') + '%)').join(' '));
    // slots are matched BY KEY, not by index: a key can be assigned to a slot
    // between the two samples, in which case its `a` count is 0.
    const aByKey = new Map();
    a.slots.forEach(s => { if (s.key) aByKey.set(s.key, s.count >>> 0); });
    const rows = [];
    b.slots.forEach(s => {
      if (!s.key) return;
      const prev = aByKey.has(s.key) ? aByKey.get(s.key) : 0;
      const dc = (s.count >>> 0) - prev;
      if (dc !== 0) rows.push({ key: s.key, dc });
    });
    rows.sort((x, y) => y.dc - x.dc);
    console.log('[census-delta] top slots (' + rows.length + ' active, slotOvf +' + d('slotOvf') + '):');
    rows.forEach(r => {
      const site = (r.key >>> 16) & 0xffff, mask = r.key & 0xffff;
      console.log('[census-delta]   site=' + (SITE_NAME[site] || site)
        + ' mask=0x' + mask.toString(16).padStart(4, '0')
        + ' [' + maskStr(mask) + ']  count=' + r.dc
        + ' (' + (dDrawn ? (100 * r.dc / dDrawn).toFixed(1) : '0') + '% of drawn)');
    });
  };
  if (process.env.PROBE_FLUSH_CENSUS) {
    // "<ms>,<ms>[,<ms>...]" — N sample points. Each sample after the first
    // prints the delta against the PREVIOUS one, so an N-arm ablation gets one
    // census window per arm out of a single process (same machine load, same
    // scene, which an across-run A/B cannot give on this box).
    const _cts = process.env.PROBE_FLUSH_CENSUS.split(',').map(x => parseInt(x.trim(), 10));
    if (_cts.length < 2 || _cts.some(isNaN)) {
      console.log('[census] PROBE_FLUSH_CENSUS must be "<ms>,<ms>[,...]" — got ' + process.env.PROBE_FLUSH_CENSUS);
    } else {
      let _cPrev = null;
      _cts.forEach((at, i) => {
        const tag = String.fromCharCode(65 + i);
        setTimeout(async () => {
          try {
            const s = await censusSnap(tag);
            if (_cPrev && s) { console.log('[census-delta] === window ' + _cPrev.tag + '->' + tag + ' ==='); censusDelta(_cPrev, s); }
            if (s) { s.tag = tag; _cPrev = s; }
          } catch (e) { console.log('[census] ' + tag + ' failed: ' + e.message); }
        }, at);
      });
      console.log('[probe] flush-census: ' + _cts.length + ' samples at ' + _cts.join('/') + 'ms');
    }
  }
  const CENSUS_OFF_MS = parseInt(process.env.PROBE_CENSUS_OFF_MS || '0', 10);
  if (CENSUS_OFF_MS > 0) {
    setTimeout(async () => {
      try {
        const r = await page.evaluate((base) => {
          if (!window.sharedMemory) return 'no sharedMemory';
          const A = new Uint32Array(window.sharedMemory.buffer);
          const before = A[base >> 2] >>> 0;
          A[base >> 2] = 1;
          return 'ctl ' + before + ' -> ' + (A[base >> 2] >>> 0);
        }, CENSUS_BASE);
        console.log('[census-off] armed at ' + CENSUS_OFF_MS + 'ms: ' + r);
      } catch (e) { console.log('[census-off] arm failed: ' + e.message); }
    }, CENSUS_OFF_MS);
  }

  // ---- [pad-watch 2026-08-29] DID THE PRESS REACH THE PAD BUFFER? ---------
  // PROBE_PAD_WATCH=<periodMs> samples the three libretro joypad bytes the page
  // writes at gamecube.html:4375 (`Module.HEAPU8[padStatus1..+2]`, base
  // `padStatus1 = Module._get_ptr(0)` at :1692) and prints every CHANGE.
  //
  // This exists because "the modal did not dismiss" has two completely different
  // causes that look identical from a screenshot: the probe pressed a key the page
  // does not bind (nothing ever reaches the pad buffer), or the pad buffer changed
  // correctly and the GUEST ignored it. A whole campaign's worth of "input is
  // broken" conclusions rests on telling those apart, and until now nothing in the
  // rig measured the boundary between them. Bit layout, from :4364-4366:
  //   b0: 1=B 2=Y 4=Select 8=Start 16=Up 32=Down 64=Left 128=Right
  //   b1: 1=A 2=X 8=Z 16=L 32=R
  if (process.env.PROBE_PAD_WATCH) {
    const perMs = parseInt(process.env.PROBE_PAD_WATCH, 10) || 100;
    const padT0 = Date.now();   // Start-click epoch, so [pad] t= matches PROBE_PRESS offsets
    let padPrev = null;
    const padTimer = setInterval(async () => {
      try {
        const v = await page.evaluate(() => {
          try {
            if (!window.Module || !Module._get_ptr) return null;
            const p = Module._get_ptr(0);
            if (!p) return null;
            return [Module.HEAPU8[p], Module.HEAPU8[p + 1], Module.HEAPU8[p + 2]];
          } catch (_e) { return null; }
        });
        if (!v) return;
        const key = v.join(',');
        if (key !== padPrev) {
          const names = [];
          if (v[0] & 1) names.push('B'); if (v[0] & 2) names.push('Y');
          if (v[0] & 4) names.push('Select'); if (v[0] & 8) names.push('Start');
          if (v[0] & 16) names.push('Up'); if (v[0] & 32) names.push('Down');
          if (v[0] & 64) names.push('Left'); if (v[0] & 128) names.push('Right');
          if (v[1] & 1) names.push('A'); if (v[1] & 2) names.push('X');
          if (v[1] & 8) names.push('Z'); if (v[1] & 16) names.push('L');
          if (v[1] & 32) names.push('R');
          console.log('[pad] t=' + ((Date.now() - padT0) / 1000).toFixed(1) + 's  b0=0x'
            + v[0].toString(16) + ' b1=0x' + v[1].toString(16) + ' b2=0x' + v[2].toString(16)
            + '  [' + (names.join(' ') || 'none') + ']');
          padPrev = key;
        }
      } catch (_e) {}
    }, perMs);
    padTimer.unref && padTimer.unref();
    console.log('[probe] pad-watch: sampling padStatus1 every ' + perMs + 'ms');
  }

  // ---- [poke 2026-08-29] generic SAB control-cell writer ------------------
  // PROBE_POKE="0x026B3B00=1@70000,0x026B3B04=1@90000" — write <val> to <cell>
  // at <ms> from the Start click. The established runtime-flag pattern is a SAB
  // scratch cell, not an env var (the worker never sees the probe's env), and
  // every such cell so far needed its own bespoke block. This is the generic
  // one. Cells currently honoured by the core:
  //   0x026B3A00 flush-census OFF        0x026B392C CoreTiming uncap
  //   0x026B3B00 draw-ablation ARM A     (WGPUGfx::DrawIndexed early-return)
  //   0x026B3B04 draw-ablation ARM B     (VertexManagerBase::Flush early-return)
  //   0x026B3B08 draw-ablation ARM A'    (VertexManagerBase::RenderDrawCall)
  if (process.env.PROBE_POKE) {
    process.env.PROBE_POKE.split(',').filter(Boolean).forEach((spec) => {
      const m = spec.trim().match(/^(0[xX][0-9a-fA-F]+|\d+)=(\d+)@(\d+)$/);
      if (!m) { console.log('[poke] spec ignored: ' + spec); return; }
      const cell = Number(m[1]), val = Number(m[2]), at = Number(m[3]);
      setTimeout(async () => {
        try {
          const r = await page.evaluate((c, v) => {
            if (!window.sharedMemory) return 'no sharedMemory';
            const A = new Uint32Array(window.sharedMemory.buffer);
            const before = A[c >> 2] >>> 0;
            A[c >> 2] = v;
            return before + ' -> ' + (A[c >> 2] >>> 0);
          }, cell, val);
          console.log('[poke] 0x' + cell.toString(16) + ' @' + at + 'ms: ' + r);
        } catch (e) { console.log('[poke] 0x' + cell.toString(16) + ' failed: ' + e.message); }
      }, at);
    });
    console.log('[probe] poke: ' + process.env.PROBE_POKE);
  }

  // ---- [nav-cycle 2026-08-29] repeated d-pad up/down, the user's exact case --
  // PROBE_NAV="<startMs>,<endMs>,<halfPeriodMs>" alternates ArrowDown / ArrowUp
  // holds for the whole window. PROBE_PRESS only fires one 500ms hold per spec,
  // which cannot reproduce "moving up and down between these" for 20+ seconds.
  // Arrows are the d-pad on the TRUSTED physical path (gamecube.html:3024-3025),
  // the same route page.keyboard already uses for PROBE_PRESS.
  if (process.env.PROBE_NAV) {
    const _nv = process.env.PROBE_NAV.split(',').map(x => parseInt(x.trim(), 10));
    if (_nv.length !== 3 || _nv.some(isNaN)) {
      console.log('[nav] PROBE_NAV must be "<startMs>,<endMs>,<halfPeriodMs>" — got ' + process.env.PROBE_NAV);
    } else {
      const [nStart, nEnd, nHalf] = _nv;
      const NAV_KEYS = (process.env.PROBE_NAV_KEYS || 'ArrowDown,ArrowUp').split(',');
      // fraction of each half-period the key is HELD. The gap has to be nonzero
      // (up and down held together is neutral), but it should be small — the
      // reported case is a hold, not a tap.
      const NAV_DUTY = parseFloat(process.env.PROBE_NAV_DUTY || '0.85');
      let nI = 0, nPresses = 0, nTimer = null;
      setTimeout(() => {
        console.log('[nav] start: alternating ' + NAV_KEYS.join('/') + ' every ' + nHalf + 'ms until ' + nEnd + 'ms');
        const step = async () => {
          const k = NAV_KEYS[nI++ % NAV_KEYS.length];
          try {
            await page.keyboard.down(k);
            await new Promise(r => setTimeout(r, Math.max(30, Math.floor(nHalf * NAV_DUTY))));
            await page.keyboard.up(k);
            nPresses++;
          } catch (e) { /* page may be closing */ }
        };
        nTimer = setInterval(step, nHalf);
        nTimer.unref && nTimer.unref();
        setTimeout(() => {
          clearInterval(nTimer);
          NAV_KEYS.forEach(k => page.keyboard.up(k).catch(() => {}));
          console.log('[nav] stop: ' + nPresses + ' presses delivered');
        }, Math.max(0, nEnd - nStart));
      }, nStart);
      console.log('[probe] nav-cycle: ' + nStart + 'ms..' + nEnd + 'ms, half-period ' + nHalf + 'ms');
    }
  }

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
            // [present-diag TEMP PM28] ViSwap entries / duplicates / Present() calls
            viSwapN: A[0x026B1B08 >> 2] >>> 0, viDupN: A[0x026B1B10 >> 2] >>> 0,
            presentN: A[0x026B1B0C >> 2] >>> 0,
            presentGate: (A[0x026B1B14 >> 2] >>> 0).toString(16),
            // [present-diag TEMP] ShowImage / ReadbackAndPresent / map-cb / pixels-posted
            wgpuChain: (A[0x026B3500 >> 2] >>> 0) + '/' + (A[0x026B3504 >> 2] >>> 0) + '/'
              + (A[0x026B3508 >> 2] >>> 0) + '/' + (A[0x026B350C >> 2] >>> 0),
            // [present-diag TEMP] CopyEFBToCacheEntry entries/gate-skips/depth-skips/blits
            xfbBlit: (A[0x026B351C >> 2] >>> 0) + '/' + (A[0x026B3520 >> 2] >>> 0) + '/'
              + (A[0x026B3524 >> 2] >>> 0) + '/' + (A[0x026B3528 >> 2] >>> 0),
            // [present-diag TEMP] RunVertices-gate-ever-hit flag / real GPU draw submissions
            gpuDraw: (A[0x026B3370 >> 2] >>> 0) + '/' + (A[0x026B352C >> 2] >>> 0),
            // [sab-diag] device errors: count/type + first message text (ASCII @0x026B3540)
            wgpuErr: (A[0x026B3530 >> 2] >>> 0) + '/t' + (A[0x026B3534 >> 2] >>> 0)
              + ' ' + (() => { const u8 = new Uint8Array(window.sharedMemory.buffer);
                let s = ''; for (let i = 0; i < 120; i++) { const b = u8[0x026B3540 + i];
                if (!b) break; s += String.fromCharCode(b); } return s; })(),
            // [sab-diag] applied viewport whxh / scissor swxsh / degenerate-vp count
            vpState: (A[0x026B3548 >> 2] >>> 0).toString(16) + '/' + (A[0x026B354C >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B3550 >> 2] >>> 0),
            // [sab-diag] PS/VS uniform-block XOR checksums (zeros-detector: an
            // all-zero block folds to XOR of indices — compare across snapshots)
            uniCk: (A[0x026B3558 >> 2] >>> 0).toString(16) + '/' + (A[0x026B355C >> 2] >>> 0).toString(16),
            // [sab-diag] DrawIndexed entries/null-pipeline/other-bail/encoder-executed
            drawPath: (A[0x026B3560 >> 2] >>> 0) + '/' + (A[0x026B3564 >> 2] >>> 0) + '/'
              + (A[0x026B3568 >> 2] >>> 0) + '/' + (A[0x026B356C >> 2] >>> 0),
            // [sab-diag] pipelines created: writeMask-None / color-enabled
            wmask: (A[0x026B3570 >> 2] >>> 0) + '/' + (A[0x026B3574 >> 2] >>> 0),
            // [sab-diag] draw-pass color view ptr / blit-source EFB texture ptr
            fbIds: (A[0x026B3578 >> 2] >>> 0).toString(16) + '/' + (A[0x026B357C >> 2] >>> 0).toString(16),
            // [sab-diag] vertex0 dword / 16-dword XOR / (nverts<<16|stride)
            vtx: (A[0x026B3580 >> 2] >>> 0).toString(16) + '/' + (A[0x026B3584 >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B3588 >> 2] >>> 0).toString(16),
            // [sab-diag] cproj row0[0] / row0[3] (f32 bits)
            proj: (A[0x026B358C >> 2] >>> 0).toString(16) + '/' + (A[0x026B3590 >> 2] >>> 0).toString(16)
              + ' pn=' + (A[0x026B3594 >> 2] >>> 0).toString(16) + '/' + (A[0x026B3598 >> 2] >>> 0).toString(16),
            // [thread-id] init / pipeline-create / draw pthread identities
            gfxThreads: (A[0x026B359C >> 2] >>> 0).toString(16) + '/' + (A[0x026B35A0 >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B35A4 >> 2] >>> 0).toString(16),
            // [sab-diag] RAW viewport y/x/h (f32 bits)
            vpRaw: (A[0x026B35A8 >> 2] >>> 0).toString(16) + '/' + (A[0x026B35AC >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B35B0 >> 2] >>> 0).toString(16),
            // [sab-diag] replicated clip x/y/w of vertex0 (f32 bits)
            clip: (A[0x026B35C0 >> 2] >>> 0).toString(16) + '/' + (A[0x026B35C4 >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B35C8 >> 2] >>> 0).toString(16),
            // [pass-diff] util pass/pipe/count/scissor ; game pass/pipe
            passDiff: (A[0x026B35D0 >> 2] >>> 0).toString(16) + '/' + (A[0x026B35D4 >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B35D8 >> 2] >>> 0) + '/' + (A[0x026B35DC >> 2] >>> 0).toString(16)
              + ' vs ' + (A[0x026B35E0 >> 2] >>> 0).toString(16) + '/' + (A[0x026B35E4 >> 2] >>> 0).toString(16),
            // [sab-diag] first 4 indices (u16 pairs) / num_indices
            idx: (A[0x026B35E8 >> 2] >>> 0).toString(16) + '/' + (A[0x026B35EC >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B35F0 >> 2] >>> 0),
            // [errscope] scoped-error status + message
            escope: (A[0x026B35F4 >> 2] >>> 0).toString(16) + ' ' + (() => {
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              let s2 = ''; for (let i = 0; i < 120; i++) { const b = u8[0x026B3600 + i];
              if (!b) break; s2 += String.fromCharCode(b); } return s2; })(),
            // [sab-diag] dual-source-blending adapter support (0x11=yes, 0x10=NO)
            dsb: (A[0x026B35F8 >> 2] >>> 0).toString(16),
            // [oob-arith PM36] base_vertex / vbuf size / (num_indices<<16|base_index)
            oob: (A[0x026B3680 >> 2] >>> 0) + '/' + (A[0x026B3684 >> 2] >>> 0)
              + '/' + (A[0x026B3688 >> 2] >>> 0).toString(16),
            // [oob-arith PM36] created-pipeline (stride<<16|attrs) / bound-pipeline
            // (stride<<16|usage<<8|attrs)
            strides: (A[0x026B368C >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B3690 >> 2] >>> 0).toString(16),
            // [xf-diag PM36] MatrixIndexA.Hex / selected xfmem row0.x bits /
            // (healthyRows<<8|firstRow) / selected row XOR
            xf: (A[0x026B369C >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B36A0 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B36A4 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B36A8 >> 2] >>> 0).toString(16),
            // [xf-diag PM36] raw posMatrices words 0-15
            xfw: Array.from({length: 16}, (_, i) =>
              (A[(0x026B36AC + i * 4) >> 2] >>> 0).toString(16)).join('/'),
            // [xf-diag PM36] immN/lastImm(addr<<16|size) | indxN/lastIndx(addr<<16|size)/srcW0
            xfl: (A[0x026B36EC >> 2] >>> 0) + '/' + (A[0x026B36F8 >> 2] >>> 0).toString(16)
              + '|' + (A[0x026B36F0 >> 2] >>> 0) + '/' + (A[0x026B36FC >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B36F4 >> 2] >>> 0).toString(16),
            // [xf-diag PM36] producer capture: triggerN + first 4 Write32 payload words
            xfp: (A[0x026B3710 >> 2] >>> 0) + ':' + Array.from({length: 4}, (_, i) =>
              (A[(0x026B3700 + i * 4) >> 2] >>> 0).toString(16)).join('/'),
            // [xf-word-loss PM37] chunk scan: off / copiedW0 / ramReread / matchN / guestAddr
            xfc: (A[0x026B3720 >> 2] >>> 0) + '/' + (A[0x026B3724 >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B3728 >> 2] >>> 0).toString(16) + '/' + (A[0x026B372C >> 2] >>> 0)
              + '/' + (A[0x026B3730 >> 2] >>> 0).toString(16),
            // [xf-word-loss PM37] xfmem[0] read-back right after write / &xfmem host addr
            xfg: (A[0x026B3734 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B3738 >> 2] >>> 0).toString(16),
            // [xf-word-loss PM37] spurious small XF loads at addr0: count / (size<<28|xfmem0-low28)
            xfs: (A[0x026B373C >> 2] >>> 0) + '/' + (A[0x026B3740 >> 2] >>> 0).toString(16),
            // [xf-word-loss PM37] canary: lastGoodSite / transFingerprint(hex prev<<8|bad)
            // / transitions / opAtTrans / culpritXfParams(hex base<<8|size)
            xfy: (A[0x026B3744 >> 2] >>> 0) + '/' + (A[0x026B3748 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B374C >> 2] >>> 0) + '/' + (A[0x026B3750 >> 2] >>> 0) + '/'
              + (A[0x026B3758 >> 2] >>> 0).toString(16),
            // [xf-word-loss PM37] display-list scan: dlN + last DL addr/size + scan of
            // the DL bytes IN GUEST RAM for the PNMTX0 header (10 00 0B 00 00) ->
            // word0 value AS STORED IN THE DL BUFFER (dead 0 here = record-time hole).
            xfd: (() => {
              const dlN = A[0x026B28A4 >> 2] >>> 0;
              const dlA = A[0x026B28A8 >> 2] >>> 0;
              const dlS = A[0x026B28AC >> 2] >>> 0;
              const m1v = A[0x02500020 >> 2] >>> 0;
              if (!dlN || !m1v || !dlA) return dlN + '/none';
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              const base = m1v + (dlA & 0x01FFFFFF);
              const lim = Math.min(dlS >>> 0, 0x4000);
              let found = [];
              for (let i = 0; i + 9 <= lim; i++) {
                if (u8[base + i] === 0x10 && u8[base + i + 1] === 0x00 &&
                    u8[base + i + 2] === 0x0B && u8[base + i + 3] === 0x00 &&
                    u8[base + i + 4] === 0x00) {
                  const w0 = (u8[base + i + 5] << 24 | u8[base + i + 6] << 16 |
                              u8[base + i + 7] << 8 | u8[base + i + 8]) >>> 0;
                  found.push(i + ':' + w0.toString(16));
                  if (found.length >= 4) break;
                }
              }
              return dlN + '/' + dlA.toString(16) + '/' + dlS + '/[' + found.join(',') + ']';
            })(),
            // [LEAF-INLINE 2026-09-01] pure-leaf `bl` splice census, written by
            // JitWasm::TryCompileBlock: candidates / spliced / idle-classified /
            // emitter-bailed, then the last idle-classified block's start_pc.
            leafInline: (A[0x026B3B60 >> 2] >>> 0) + '/' + (A[0x026B3B64 >> 2] >>> 0)
              + '/' + (A[0x026B3B68 >> 2] >>> 0) + '/' + (A[0x026B3B70 >> 2] >>> 0)
              + ' lastIdlePc=' + (A[0x026B3B6C >> 2] >>> 0).toString(16),
            // [xf-word-loss PM37] producer first-word split: n(1.0) / n(0) / n(other) / lastOther
            // [m00-hunt PM37] runtime lanes at 0x800bb8f4: fbps1 / faps0 / result / hits
            xfi: (A[0x026B37B4 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37B8 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37BC >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37C0 >> 2] >>> 0),
            // [m00-hunt PM37] the 0x800bb90c psq_st: storedPs0Bits / hostAddr / EA
            // / fastN / slowN
            xfj: (A[0x026B37C4 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37C8 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37CC >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37D0 >> 2] >>> 0) + '/' + (A[0x026B37D4 >> 2] >>> 0),
            // [m00-hunt PM37] Concat m00 store 0x800bb4dc: bits / lastEA / N /
            // group-mtx-pinned bits / pinned N
            xfk: (A[0x026B37D8 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37DC >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37E0 >> 2] >>> 0) + '/'
              + (A[0x026B37E4 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B37E8 >> 2] >>> 0) + '|f64='
              + (A[0x026B37F0 >> 2] >>> 0).toString(16) + ':'
              + (A[0x026B37EC >> 2] >>> 0).toString(16)
              + '|a00=' + (A[0x026B37F4 >> 2] >>> 0).toString(16)
              + ' b00=' + (A[0x026B37F8 >> 2] >>> 0).toString(16)
              + ' r3=' + (A[0x026B37FC >> 2] >>> 0).toString(16)
              + ' r4=' + (A[0x026B3820 >> 2] >>> 0).toString(16),
            // [m00-hunt PM37] PSMTXScale stfs xS: zeroN / nonzeroN / lastNonzero / lastEA
            xfl2: (A[0x026B3800 >> 2] >>> 0) + '/' + (A[0x026B3804 >> 2] >>> 0) + '/'
              + (A[0x026B3808 >> 2] >>> 0).toString(16) + '/'
              + (A[0x026B380C >> 2] >>> 0).toString(16),
            // [m00-hunt PM37] Scale stfs PINNED to 0x801E6AC4: zeroN / nonzeroN / lastBits
            // + stfs host @3840 | psq_l pinned: host @3830 / bits @3834 / fastN / slowN
            xfn: (A[0x026B3824 >> 2] >>> 0) + '/' + (A[0x026B3828 >> 2] >>> 0) + '/'
              + (A[0x026B382C >> 2] >>> 0).toString(16) + '/sthost='
              + (A[0x026B3840 >> 2] >>> 0).toString(16) + '|ldhost='
              + (A[0x026B3830 >> 2] >>> 0).toString(16) + ' ldbits='
              + (A[0x026B3834 >> 2] >>> 0).toString(16) + ' fastN='
              + (A[0x026B3838 >> 2] >>> 0) + ' slowN=' + (A[0x026B383C >> 2] >>> 0),
            // [m00-hunt PM37] resting bytes of sprman temp row0 (guest 0x801E6AC4,
            // 16 bytes = m00,m01,m02,m03) read directly from shared memory
            xfo: (() => {
              const m1v = A[0x02500020 >> 2] >>> 0;
              if (!m1v) return 'nomem';
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              const b = m1v + 0x1E6AC4;
              const w = o => ((u8[b + o] << 24 | u8[b + o + 1] << 16 | u8[b + o + 2] << 8 |
                               u8[b + o + 3]) >>> 0).toString(16);
              return [0, 4, 8, 12].map(w).join('/');
            })(),
            // [PM51 TEMP] chain bail census: serviceBail/vectorBail/chainTaken/tagMiss
            chainCensus: (A[0x026B38D0 >> 2] >>> 0) + '/' + (A[0x026B38D4 >> 2] >>> 0)
              + '/' + (A[0x026B38D8 >> 2] >>> 0) + '/' + (A[0x026B38DC >> 2] >>> 0),
            // [render-gaps R1 PM38] EFB->RAM copies: entries / readbacks started / encodes done
            efbram: (A[0x026B384C >> 2] >>> 0) + '/' + (A[0x026B3850 >> 2] >>> 0) + '/'
              + (A[0x026B3854 >> 2] >>> 0) + '/flags='
              + (A[0x026B3858 >> 2] >>> 0).toString(16),
            // [m00-hunt PM37] mem1_base rebase detector: changes / first / latest / probe m1v
            xfb: (A[0x026B3810 >> 2] >>> 0) + '/' + (A[0x026B3814 >> 2] >>> 0).toString(16)
              + '/' + (A[0x026B3818 >> 2] >>> 0).toString(16) + '/'
              + (A[0x02500020 >> 2] >>> 0).toString(16),
            xfz: (A[0x026B37A4 >> 2] >>> 0) + '/' + (A[0x026B37A8 >> 2] >>> 0) + '/'
              + (A[0x026B37AC >> 2] >>> 0) + '/' + (A[0x026B37B0 >> 2] >>> 0).toString(16),
            // [xf-word-loss PM37] MEM1 scan for the movie matrix BODY (words 1-11 BE:
            // 0,0,153f,0, 1f,0,402f,0, 0,0,1f? -> see bytes below); reports each hit's
            // guest addr + word0 (m00) AS STORED IN RAM. m00==0 in RAM = the JIT
            // COMPUTED the matrix wrong; all-1.0 = the psq streaming lies.
            xfm: (() => {
              const m1v = A[0x02500020 >> 2] >>> 0;
              if (!m1v) return 'nomem';
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              // w1..w11 big-endian bytes (44 bytes): 0,0,43 19 00 00,0, 3F 80 00 00,
              // 0, 43 C9 00 00, 0, 0, 3F 80 00 00, 0
              const pat = [];
              const pw = [0, 0, 0x43190000, 0, 0x3F800000, 0, 0x43C90000, 0, 0, 0x3F800000, 0];
              for (const w of pw) { pat.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255); }
              const hits = [];
              const end = m1v + 0x01800000 - 48;
              for (let p = m1v; p < end; p += 4) {
                if (u8[p + 4] !== pat[0]) continue;  // quick reject on w1 byte0 (0)
                if (u8[p + 12] !== 0x43 || u8[p + 13] !== 0x19) continue;  // w3 = 153f
                let ok = true;
                for (let k = 0; k < 44; k++) { if (u8[p + 4 + k] !== pat[k]) { ok = false; break; } }
                if (!ok) continue;
                const w0 = (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0;
                hits.push(((p - m1v) >>> 0).toString(16) + ':' + w0.toString(16));
                if (hits.length >= 8) break;
              }
              return '[' + hits.join(',') + ']';
            })(),
            // [xf-word-loss PM37] HuSprGrpData[4] fields (guest 0x80155BE0):
            // cap/x/y/z_rot/scale_x/scale_y/center_x/center_y (BE f32 hex)
            xfh: (() => {
              const m1v = A[0x02500020 >> 2] >>> 0;
              if (!m1v) return 'nomem';
              const u8 = new Uint8Array(window.sharedMemory.buffer);
              const b = m1v + 0x155BE0;
              const w = o => ((u8[b + o] << 24 | u8[b + o + 1] << 16 | u8[b + o + 2] << 8 |
                               u8[b + o + 3]) >>> 0).toString(16);
              return [4, 8, 0xC, 0x10, 0x14, 0x18, 0x1C].map(w).join('/');
            })(),
            // [xf-word-loss PM37] event ring (head + 16 tag:seq entries, oldest->newest)
            xfr: (() => {
              const h = A[0x026B37A0 >> 2] >>> 0;
              const es = [];
              for (let i = 0; i < 16; i++) {
                const e = A[(0x026B3760 + (((h + i) & 15) * 4)) >> 2] >>> 0;
                es.push((e >>> 28) + ':' + (e & 0x0FFFFFFF));
              }
              return h + '|' + es.join(',');
            })(),
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

  // ---- [xfb-band PM45 TEMP] PROBE_MEM1_PEEK="hexoff,hexoff,...@ms": dump 32 bytes of
  // guest MEM1 at each offset (mem1base from SAB cell 0x02500020, crash-slot pattern).
  if (process.env.PROBE_MEM1_PEEK) {
    const pm = process.env.PROBE_MEM1_PEEK.match(/^(.+)@(\d+)$/);
    if (pm) setTimeout(async () => {
      try {
        const offs = pm[1].split(',').map(s => parseInt(s, 16));
        const out = await page.evaluate((offsets) => {
          if (!window.sharedMemory) return 'no sharedMemory';
          const A = new Uint32Array(window.sharedMemory.buffer);
          const B = new Uint8Array(window.sharedMemory.buffer);
          const base = A[0x02500020 >> 2] >>> 0;
          if (!base) return 'mem1base=0';
          return offsets.map((off) => {
            let s = 'off=0x' + off.toString(16) + ':';
            for (let i = 0; i < 32; i++)
              s += ' ' + B[base + off + i].toString(16).padStart(2, '0');
            return s;
          }).join('\n');
        }, offs);
        console.log('[mem1-peek @' + pm[2] + 'ms]\n' + out);
      } catch (e) { console.log('[probe] mem1-peek failed: ' + e.message); }
    }, parseInt(pm[2], 10));
  }

  // ---- report the WASM build's own raw DoState size (format-compat check) --
  if (process.env.PROBE_STATE_SIZE_MS) {
    setTimeout(async () => {
      try {
        const sz = await page.evaluate(() => window.__probeStateSize ? window.__probeStateSize() : -1);
        console.log('[probe] WASM raw DoState size = ' + sz + ' bytes');
      } catch (e) { console.log('[probe] state-size check failed: ' + e.message); }
    }, parseInt(process.env.PROBE_STATE_SIZE_MS, 10));
  }

  // ---- [AOT A1] prebuilt-block registry telemetry (absolute SAB cells) -----
  // PROBE_AOT=<pollMs>: dump the AOT registry/swap counters every pollMs. Reads
  // 0x026B3468..0x026B348C (see JitWasm.cpp AotEntry note). Read-only probe-side.
  if (process.env.PROBE_AOT) {
    const pollMs = parseInt(process.env.PROBE_AOT, 10) || 2000;
    const killReq = process.env.PROBE_AOT_KILL === '1';
    const smcReq = process.env.PROBE_AOT_SMC === '1';
    const dumpAot = async () => {
      try {
        const r = await page.evaluate((flags) => {
          if (!window.sharedMemory) return null;
          const A = new Uint32Array(window.sharedMemory.buffer);
          const rd = (a) => A[a >> 2] >>> 0;
          if (flags[0]) A[0x026B3474 >> 2] = 1;  // KILL switch on: force JIT path
          // [AOT A3.1 SMC] arm the SMC trigger once the AOT gen is sealed, via the
          // SAME write path the kill switch proved works cross-thread.
          if (flags[1] && A[0x026B34CC >> 2] === 1 && A[0x026B34D0 >> 2] === 0) A[0x026B34C8 >> 2] = 1;
          return {
            ptr: rd(0x026B3468), len: rd(0x026B346C), n: rd(0x026B3470),
            kill: rd(0x026B3474), hits: rd(0x026B3478), integ_mm: rd(0x026B347C),
            ctx_mm: rd(0x026B3480), live_ctx: rd(0x026B3484),
            baked_ctx: rd(0x026B3488), status: rd(0x026B348C),
            m_status: rd(0x026B34A4), m_n: rd(0x026B34A8), m_gen: rd(0x026B34AC),
            m_ctx_mm: rd(0x026B34B4), m_seals: rd(0x026B34B8), m_auth_mm: rd(0x026B34BC),
            m_disp: rd(0x026B34C0), m_sealed: rd(0x026B34CC), m_smc: rd(0x026B34D0),
            m_steal: rd(0x026B34D4),
            // [census 2026-08-13c Item 1] per-exit-reason counters (diag asset only)
            cx_taken: rd(0x026B34D8), cx_svc: rd(0x026B34DC), cx_vec: rd(0x026B34E0),
            cx_direct: rd(0x026B34E4), cx_warm: rd(0x026B34E8), cx_gfb: rd(0x026B34EC),
            cx_host: rd(0x026B34F0), cx_lap: rd(0x026B34F4),
          };
        }, [killReq, smcReq]);
        if (r) console.log('[aot] n=' + r.n + ' status=0x' + r.status.toString(16) +
          ' hits=' + r.hits + ' hash_mm=' + r.integ_mm + ' ctx_mm=' + r.ctx_mm +
          ' live_ctx=0x' + r.live_ctx.toString(16) + ' kill=' + r.kill +
          ' | MERGED n=' + r.m_n + ' status=0x' + r.m_status.toString(16) + ' gen=0x' + r.m_gen.toString(16) +
          ' seals=' + r.m_seals + ' auth_mm=' + r.m_auth_mm +
          ' DISPATCHES=' + r.m_disp + ' steals=' + r.m_steal + (smcReq ? ' | SMC sealed=' + r.m_sealed + ' evicted=' + r.m_smc : ''));
        if (r) console.log('[census] taken=' + r.cx_taken + ' warm_br=' + r.cx_warm + ' svc_bail=' + r.cx_svc + ' vec=' + r.cx_vec + ' direct=' + r.cx_direct + ' global_fb=' + r.cx_gfb + ' host_ret=' + r.cx_host + ' lap=' + r.cx_lap);
      } catch (e) { console.log('[aot] peek failed: ' + e.message); }
    };
    const aotTimer = setInterval(dumpAot, pollMs);
    if (typeof cleanupFns !== 'undefined') cleanupFns.push(() => clearInterval(aotTimer));
  }

  // [AOT A3.1 acceptance #2] scripted SMC test: PROBE_AOT_SMC=<ms> flips a bit in
  // HandleReverb's guest range (worker writes 0x026B34C8=1 trigger) and asserts
  // the AOT gen unseals (0x026B34CC 1->0) + dispatch stops climbing (JIT fallback).

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

  // ---- MIPS meter readout (executed vs credited, steady window) -----------
  try {
    const m = await page.evaluate(() => window.__mips || null);
    if (m && m.winStart && m.last) {
      const execD = m.last.execAccum - m.winStart.execAccum;
      const credD = m.last.cred - m.winStart.cred;
      const wallS = (m.last.wall - m.winStart.wall) / 1000;
      const execMHz = wallS > 0 ? execD / wallS / 1e6 : 0;
      const credMHz = wallS > 0 ? credD / wallS / 1e6 : 0;
      const ratio = credD > 0 ? execD / credD : 0;
      console.log('[mips] EXECUTED=' + execMHz.toFixed(1) + ' MHz  CREDITED=' + credMHz.toFixed(1)
        + ' MHz  ratio=' + (ratio * 100).toFixed(1) + '%  phantom=' + ((1 - ratio) * 100).toFixed(1)
        + '%  (steady ' + wallS.toFixed(1) + 's; native Gekko=486 MHz)');
    } else {
      console.log('[mips] no steady-window sample (run shorter than MIPS_WINDOW_MS or meter compiled off)');
    }
    if (m && m.traceN > 0) {
      const p = m.tracePeriod / m.traceN, busy = m.traceDecode / m.traceN;
      const idle = p - busy;
      const pct = (x) => p > 0 ? (100 * x / p).toFixed(0) : '0';
      console.log('[trace] frame_period=' + p.toFixed(1) + 'ms = device_busy(decode+flush) ' + busy.toFixed(1)
        + ' + idle/guest-wait ' + idle.toFixed(1) + ' ms  (' + m.traceN + ' frames)  → device '
        + pct(busy) + '% / guest-wait ' + pct(idle) + '%');
    } else {
      console.log('[trace] no frame-turnaround samples');
    }
    if (m) {
      console.log('[trace-raw] counter=' + (m.lastCtr || 0) + '  last_busy=' + (m.lastBusy || 0).toFixed(2)
        + 'ms  pe_finish=' + (m.lastFin || 0).toFixed(1) + ' (epoch ms)');
    }
  } catch (e) { console.error('[mips] readout failed: ' + e.message); }

  // ---- [guestclock] + [fps] readout ---------------------------------------
  try {
    const g = await page.evaluate(() => window.__gclk || null);
    if (!g) {
      console.log('[guestclock] sampler absent');
    } else if (!g.winStart || !g.last) {
      console.log('[guestclock] no steady-window sample (run shorter than MIPS_WINDOW_MS)'
        + (g.last ? '  last: aidma=' + g.last.aidma + ' aid=' + g.last.aid
                  + ' period=' + g.last.period + ' ticksHz=' + g.last.ticksHz : '')
        + (g.err ? '  err=' + g.err : ''));
    } else {
      const emitArm = (tag, a, b) => {
        const wallS = (b.wall - a.wall) / 1000;
        const dAidma = b.aidma - a.aidma;
        const dAid = b.aid - a.aid;
        // Expected hardware rates come from the cells the EMULATOR published, so
        // no 486MHz/divisor assumption is baked into the probe. (Measured live:
        // ticksHz=486000000, period=121392 => divisor 3372, not the 3375 the
        // 121,500-tick estimate assumed; hw callback rate is 4003.56/s.)
        const expAidma = (b.ticksHz > 0 && b.period > 0) ? (b.ticksHz / b.period) : 0;
        const expAid = (expAidma > 0 && b.numBlocks > 0) ? (expAidma / b.numBlocks) : 0;
        const rAidma = wallS > 0 ? dAidma / wallS : 0;
        const rAid = wallS > 0 ? dAid / wallS : 0;
        console.log('[guestclock:' + tag + '] RAW  ticksHz=' + b.ticksHz + ' period=' + b.period
          + ' NumBlocks=' + b.numBlocks + '  window=' + wallS.toFixed(2) + 's'
          + '  d(ai_dma_cb)=' + dAidma + '  d(aid_fire)=' + dAid);
        console.log('[guestclock:' + tag + '] ai_dma_cb=' + rAidma.toFixed(2) + '/s (hw '
          + expAidma.toFixed(2) + '/s) => guest='
          + (expAidma > 0 ? (rAidma / expAidma).toFixed(4) : 'n/a') + 'x'
          + '   aid_fire=' + rAid.toFixed(2) + '/s (hw ' + expAid.toFixed(2)
          + '/s) => guest=' + (expAid > 0 ? (rAid / expAid).toFixed(4) : 'n/a') + 'x');
        // Delivered fps on the live SAB-present path. /2 because 0x026B3518 is a
        // seqlock bumped twice per frame (WGPUGfx.cpp:1241 begin -> odd,
        // :1263 end -> even), NOT a plain frame counter.
        const dPub = (b.presentSeq - a.presentSeq) / 2;
        const dShown = b.rafSeen - a.rafSeen;
        const dPe = b.peFrames - a.peFrames;
        console.log('[fps:' + tag + '] delivered published=' + (wallS > 0 ? (dPub / wallS).toFixed(2) : '0')
          + '/s  shown(rAF-distinct)=' + (wallS > 0 ? (dShown / wallS).toFixed(2) : '0')
          + '/s  guest_pe_finish=' + (wallS > 0 ? (dPe / wallS).toFixed(2) : '0')
          + '/s  (SAB present seqlock @0x026B3518 /2; steady ' + wallS.toFixed(2) + 's)');
        // MP4 guest-side cross-check. retraceCount is the VI field counter, so
        // d(retrace)/59.94 is a GUEST-VISIBLE guest-clock estimate (it passes
        // through interrupt delivery and guest ISR execution, unlike the AI-DMA
        // counter which is host-side); d(retrace)/d(globalCounter) is the
        // scene's actual minimumVcount, which is what turns a frame count into
        // a multiple (main.c:83,115,120-122).
        const dGc = b.globalCounter - a.globalCounter;
        const dRt = b.retraceCount - a.retraceCount;
        if (dRt > 0 || dGc > 0) {
          const vcount = dGc > 0 ? (dRt / dGc) : 0;
          console.log('[guestclock-mp4:' + tag + '] d(GlobalCounter)=' + dGc + ' ('
            + (dGc / wallS).toFixed(2) + '/s)  d(retraceCount)=' + dRt + ' ('
            + (dRt / wallS).toFixed(2) + '/s)'
            + '  measured vcount=' + (vcount ? vcount.toFixed(3) : 'n/a')
            + '  retrace-derived guest=' + ((dRt / wallS) / 59.94).toFixed(4) + 'x'
            + '  (NTSC VI field rate 59.94/s)');
        } else {
          console.log('[guestclock-mp4:' + tag + '] GlobalCounter/retraceCount did not advance'
            + ' (gc=' + b.globalCounter + ' rt=' + b.retraceCount + ') — not MP4, or wedged');
        }
      };
      if (g.preUncap && g.preUncap.start && g.preUncap.end) {
        emitArm('throttled', g.preUncap.start, g.preUncap.end);
      }
      emitArm(g.preUncap ? 'uncapped' : 'throttled', g.winStart, g.last);
    }
  } catch (e) { console.error('[guestclock] readout failed: ' + e.message); }

  // ---- [batch-instances] readout ------------------------------------------
  // ARM-DIFFERENCE PROOF for the blocks-per-module A/B (?bjit_batch=<K>). The
  // batching runs on the EmuThread pthread, whose console does NOT relay to
  // page.on('console') (PM53d), so the only honest witness is the SAB census
  // block.cache writes: K echo, modules built, block slots re-pointed, failures
  // and cumulative build ms. Read ONCE, after the measured window, so it cannot
  // perturb the numbers above. A K>0 run whose modules==0 is a VOID arm — the
  // flag did not reach the JIT and the run measures the control.
  //   0x026B39A0 K (W) · 39A4 modules · 39A8 blocks · 39AC failed · 39B0 ms · 39B4 kEcho
  try {
    const bi = await page.evaluate(() => {
      if (!window.sharedMemory) return null;
      const A = new Uint32Array(window.sharedMemory.buffer);
      return {
        k: A[0x026B39A0 >> 2] >>> 0, kEcho: A[0x026B39B4 >> 2] >>> 0,
        modules: A[0x026B39A4 >> 2] >>> 0, blocks: A[0x026B39A8 >> 2] >>> 0,
        failed: A[0x026B39AC >> 2] >>> 0, ms: A[0x026B39B0 >> 2] >>> 0,
        mapSize: A[0x026B3944 >> 2] >>> 0, mapPeak: A[0x026B3948 >> 2] >>> 0,
        distinctPc: A[0x026B395C >> 2] >>> 0, compiles: A[0x026B394C >> 2] >>> 0,
      };
    });
    if (!bi) {
      console.log('[batch-instances] sharedMemory absent');
    } else {
      // Live instance estimate: every compiled block owns a slot; a batched
      // block's slot points into a shared module instead of its own. So
      // instances ~= (blocks still per-module) + (batch modules).
      const perBlock = Math.max(0, bi.mapSize - bi.blocks);
      console.log('[batch-instances] K=' + bi.k + ' (echo ' + bi.kEcho + ')'
        + '  modules=' + bi.modules + '  blocks_repointed=' + bi.blocks
        + '  failed=' + bi.failed + '  build_ms=' + bi.ms
        + '  | cache map=' + bi.mapSize + ' peak=' + bi.mapPeak
        + ' distinctPc=' + bi.distinctPc + ' compiles=' + bi.compiles
        + '  => live wasm instances ~= ' + (perBlock + bi.modules)
        + ' (' + perBlock + ' per-block + ' + bi.modules + ' batch)');
      if (bi.k >= 2 && bi.modules === 0)
        console.log('[batch-instances] VOID ARM: K was set but no batch module was built');
    }
  } catch (e) { console.error('[batch-instances] readout failed: ' + e.message); }

  // ---- [restore witness] readout ------------------------------------------
  if (process.env.PROBE_RESTORE_WITNESS === '1') {
    try {
      const rw = await page.evaluate(() => (window.__rw
        ? { s: window.__rw.s, err: window.__rw.err, at: window.__restoreAt || null } : null));
      if (!rw || !rw.s || rw.s.length < 3) {
        console.log('[restore-witness] no samples' + (rw && rw.err ? ' err=' + rw.err : ''));
      } else {
        const s = rw.s;
        let biggest = null, maxCh = null;
        for (let i = 1; i < s.length; i++) {
          const dc = s[i].cred - s[i - 1].cred;
          // A restore is a step; normal execution advances ~4.86e8*dt cycles/s.
          if (!biggest || Math.abs(dc) > Math.abs(biggest.dc)) biggest = { dc: dc, t: s[i].t, i: i };
          if (s[i].ch >= 0 && (!maxCh || s[i].ch > maxCh.ch)) maxCh = { ch: s[i].ch, t: s[i].t };
        }
        // Typical per-200ms advance over the run, for scale.
        const deltas = [];
        for (let i = 1; i < s.length; i++) deltas.push(s[i].cred - s[i - 1].cred);
        deltas.sort((a, b) => a - b);
        const med = deltas[deltas.length >> 1];
        console.log('[restore-witness] samples=' + s.length
          + '  median d(global_timer)/200ms=' + med.toLocaleString()
          + '  LARGEST step=' + (biggest ? biggest.dc.toLocaleString() : 'n/a')
          + ' at t=' + (biggest ? (biggest.t / 1000).toFixed(2) : 'n/a') + 's'
          + '  (=' + (biggest && med ? (biggest.dc / med).toFixed(1) : 'n/a') + 'x the median)');
        console.log('[restore-witness] MEM1 fingerprint: max changed words in one 200ms tick = '
          + (maxCh ? maxCh.ch : 'n/a') + '/512 at t=' + (maxCh ? (maxCh.t / 1000).toFixed(2) : 'n/a') + 's'
          + (rw.at ? '   (page handed the state to the worker at t=' + (rw.at / 1000).toFixed(2) + 's)' : ''));
        console.log('[restore-witness] VERDICT: '
          + (biggest && med && Math.abs(biggest.dc) > 20 * Math.abs(med)
             ? 'DISCONTINUITY PRESENT — CoreTiming was replaced, i.e. DoState ran'
             : 'NO DISCONTINUITY — nothing replaced CoreTiming; treat any scene claim as UNPROVEN'));
      }
    } catch (e) { console.error('[restore-witness] readout failed: ' + e.message); }
  }

  // ---- dump pc-sample histogram ------------------------------------------
  if (PC_SAMPLE) {
    try {
      const dump = await page.evaluate(() => {
        const st = window.__pcSamp; if (!st) return null;
        return st.segs.map((sg, i) => sg ? ({ seg: i, n: sg.n, gcmin: sg.gcmin,
          gcmax: sg.gcmax, hist: Array.from(sg.hist.entries()) }) : null);
      });
      fs.writeFileSync('/tmp/wasm_pc_hist.json', JSON.stringify(dump));
      const tot = (dump || []).reduce((a, s) => a + (s ? s.n : 0), 0);
      console.log('[probe] pc-sample: ' + tot + ' samples → /tmp/wasm_pc_hist.json');
    } catch (e) { console.error('[probe] pc-sample dump failed: ' + e.message); }
  }

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
        let nonBlack = 0, firstRow = -1, lastRow = -1;
        const rowPx = c.width;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] !== 0 || data[i+1] !== 0 || data[i+2] !== 0) {
            nonBlack++;
            const row = Math.floor((i / 4) / rowPx);
            if (firstRow < 0) firstRow = row;
            lastRow = row;
          }
        }
        // sample 4 pixels across the first non-black row (color variety test)
        let samples = [];
        if (firstRow >= 0) {
          for (const x of [0, 160, 320, 560]) {
            const o = (firstRow * rowPx + x) * 4;
            samples.push(data[o] + ',' + data[o+1] + ',' + data[o+2]);
          }
        }
        return { found: true, has2d: true, w: c.width, h: c.height, nonBlack,
                 total: data.length / 4, firstRow, lastRow, samples };
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
            // [interp-CLASS 2026-07-20] cmd9 fallbacks ranked by op<<10|XO class (complete, unlike the 8-slot pc hist)
            bw.interpClassHist = (() => { const rows=[]; for(let k=0;k<32;k++){const sp=0x02500280+k*12; const key=A[sp>>2]>>>0; const c=A[(sp+8)>>2]>>>0; if(key&&c) rows.push(['op'+(((key-1)>>>10)&0x3F)+((((key-1)&0x3FF))?('.'+((key-1)&0x3FF)):'')+'/i'+(A[(sp+4)>>2]>>>0).toString(16), c]);} rows.sort((x,y)=>y[1]-x[1]); return rows.map(r=>r[0]+'='+r[1]).join(' '); })();
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
            bw.wgpGateMs = (A[0x026B27E8 >> 2] >>> 0) / 10;  // [gate-wait-time] total wall-ms blocked in the gate
            // [worker-fifo 2026-07-21] native-architecture gather pipe state
            bw.wfArmed = A[0x026B2840 >> 2] >>> 0;
            bw.wfWp = '0x' + (A[(0x026B2840 + 12) >> 2] >>> 0).toString(16);
            bw.wfBurstN = A[(0x026B2840 + 20) >> 2] >>> 0;
            bw.wfDlBurstN = A[(0x026B2840 + 24) >> 2] >>> 0;  // DL-buffer (uncredited) bursts
            bw.wfDisarm16 = A[(0x026B2840 + 28) >> 2] >>> 0;
            bw.wfSyncedBursts = A[0x026B285C >> 2] >>> 0;
            // [vi-struct diag 2026-07-21 TEMP] setFbbRegs INPUTS + outputs from guest memory:
            // fbBase @0x801A6168 (stw r30,288(r31)), PanPosX @0x801A614E (lhz 22(r3), r3=base+0xF0),
            // computed tfbl scratch @0x801A616C (r4=base+292), shadow TFBL pair @0x801A6064 (sth 28/30(r9)).
            bw.viStruct = (() => { const m1 = A[0x02500020 >> 2] >>> 0; if (!m1) return 'nomem';
              const g = (ga) => { const w = A[((m1 + (ga & 0x01FFFFFF)) >>> 0) >> 2] >>> 0; return (((w & 0xFF) << 24) | ((w & 0xFF00) << 8) | ((w >>> 8) & 0xFF00) | (w >>> 24)) >>> 0; };
              return 'fb=0x' + g(0x801A6168).toString(16) + ' panX=0x' + ((g(0x801A614C) & 0xFFFF) >>> 0).toString(16)
                + ' tfblScratch=0x' + g(0x801A616C).toString(16) + ' shadowTFBL=0x' + g(0x801A6064).toString(16); })();
            bw.viFbW = 'hi16=0x' + (A[0x026B287C >> 2] >>> 0).toString(16) + '/' + (A[0x026B2884 >> 2] >>> 0)
              + ' lo16=0x' + (A[0x026B2880 >> 2] >>> 0).toString(16) + '/' + (A[0x026B2888 >> 2] >>> 0)
              + ' w32=0x' + (A[0x026B288C >> 2] >>> 0).toString(16) + '/' + (A[0x026B2890 >> 2] >>> 0);
            bw.lowmemHit = (A[0x026B2918 >> 2] >>> 0) ? ('val=0x' + (A[0x026B29A8 >> 2] >>> 0).toString(16) + ' pc=0x' + (A[0x026B291C >> 2] >>> 0).toString(16)
              + ' head=' + (A[0x026B2920 >> 2] >>> 0)
              + ' ring=' + Array.from({length: 32}, (_, k) => (A[(0x026B2924 + k*4) >> 2] >>> 0).toString(16)).join(',')) : 'clean';
            bw.fpuVecN = A[0x026B2914 >> 2] >>> 0;   // [fpu-vec] inline 0x800 deliveries
            bw.gqrs = (() => { const c = A[0x0250002C >> 2] >>> 0; if (!c) return 'noctx';
              return Array.from({length: 8}, (_, i) => i + ':0x' + (A[(c + 0x340 + (912 + i) * 4) >> 2] >>> 0).toString(16)).join(' '); })();
            bw.dvdIsrN = A[0x026B2910 >> 2] >>> 0;   // [dvd-isr] guest __DVDInterruptHandler entries
            bw.diIntN = (A[0x026B2908 >> 2] >>> 0) + '/t' + (A[0x026B290C >> 2] >>> 0);  // DI int generates / last type
            bw.texImg3 = '0x' + (A[0x026B2900 >> 2] >>> 0).toString(16) + '/' + (A[0x026B2904 >> 2] >>> 0);
            bw.texHash = (() => { const m1 = A[0x02500020 >> 2] >>> 0; const t3 = A[0x026B2900 >> 2] >>> 0;
              if (!m1 || !t3) return 'none';
              const pa = (t3 << 5) & 0x01FFFFFF; let h = 0x811c9dc5;
              for (let k = 0; k < 0x2000; k += 16) { h ^= A[(m1 + pa + k) >> 2]; h = (h * 0x01000193) >>> 0; }
              return '0x' + (h >>> 0).toString(16); })();
            bw.garbageDraw = (A[0x026B28B8 >> 2] >>> 0) ? Array.from({length: 16}, (_, k) => {
              const w = A[(0x026B28C0 + k*4) >> 2] >>> 0;
              return [w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, (w >>> 24) & 0xFF].map(b => b.toString(16).padStart(2, '0')).join(' ');
            }).join(' ') : 'none';
            bw.drawN = A[0x026B289C >> 2] >>> 0;                                     // [copy-gap] prim draws decoded
            bw.drawVerts = A[0x026B28A0 >> 2] >>> 0;                                 // total vertices
            bw.dlCallN = A[0x026B28A4 >> 2] >>> 0;                                   // CALL_DL count
            bw.dlCallLast = '0x' + (A[0x026B28A8 >> 2] >>> 0).toString(16) + '/' + (A[0x026B28AC >> 2] >>> 0);
            bw.draw24 = Array.from({length: 8}, (_, k) => (A[(0x026B1AC8 + k*8) >> 2] >>> 0) + 'x' + (A[(0x026B1AC8 + k*8 + 4) >> 2] >>> 0)).join(' ');
            bw.efbCopyN = A[0x026B2894 >> 2] >>> 0;                                  // [copy-diag] EFB-copy executes
            bw.efbCopyDest = '0x' + (A[0x026B2898 >> 2] >>> 0).toString(16);          // last copy dest
            bw.xfbRaw = '0x' + (A[0x026B2834 >> 2] >>> 0).toString(16);      // pre-latch VI xfbAddr
            bw.xfbRegTop = '0x' + (A[0x026B2838 >> 2] >>> 0).toString(16);   // raw m_xfb_info_top.Hex
            bw.wfCp = 'wp=0x' + (A[0x026B2860 >> 2] >>> 0).toString(16) + ' rp=0x' + (A[0x026B2864 >> 2] >>> 0).toString(16)
              + ' dist=' + (A[0x026B2868 >> 2] >>> 0) + ' base=0x' + (A[0x026B286C >> 2] >>> 0).toString(16)
              + ' end=0x' + (A[0x026B2870 >> 2] >>> 0).toString(16) + ' link=' + (A[0x026B2874 >> 2] >>> 0)
              + ' wfwp=0x' + (A[0x026B2878 >> 2] >>> 0).toString(16);
            bw.mirrorHits = A[0x026B2830 >> 2] >>> 0;     // [mmio-mirror] reads served from the SAB block
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
            // [dc-diag 2026-07-21 TEMP] localize the PE_FINISH break in the gpu_thread RunGpuLoop chain
            bw.rglEntry = A[0x026B1AD0 >> 2] >>> 0;        // RunGpuLoop callback ticks (gpu_thread alive?)
            bw.rglDrain = A[0x026B1AD4 >> 2] >>> 0;        // RunGpuLoop while-loop drain iterations
            // [vtxloader A/B 2026-08-28] emitted wasm vertex loader vs the scalar software one.
            // vtxSw is the live arm (1 = forced software); vtxCmp/vtxMis/vtxKinds are the
            // correctness gate under ?bjit_vtx_compare=1, which runs BOTH loaders and diffs
            // them. PASS = vtxCmp > 0 AND vtxMis == 0 — vtxCmp == 0 means the gate never ran,
            // which is NOT a pass. Reported here rather than via ASSERT because ASSERT_MSG
            // routes through PanicYesNoFmtAssert and can log-and-continue instead of failing.
            bw.vtxSw = A[0x026B3900 >> 2] >>> 0;           // 1 = software loader forced
            bw.vtxCmp = A[0x026B3910 >> 2] >>> 0;          // compare runs (0 = gate never ran)
            bw.vtxMis = A[0x026B3908 >> 2] >>> 0;          // mismatches (must be 0)
            bw.vtxKinds = (A[0x026B390C >> 2] >>> 0).toString(16);  // which checks differed
            // [positive control 2026-08-29] mismatches==0 proves nothing on its own:
            // RunVertices silently falls back to the software loader when codegen
            // fails, which makes Compare diff software against ITSELF and pass. A
            // real PASS is vtxEmit > 0 AND vtxFall == 0 AND vtxMis == 0.
            bw.vtxEmit = A[0x026B3980 >> 2] >>> 0;         // draws run by emitted wasm
            bw.vtxFall = A[0x026B3984 >> 2] >>> 0;         // draws that fell back to software
            bw.vtxPois = A[0x026B3988 >> 2] >>> 0;         // 1 = fault injected (teeth check)
            // [selection trace] 1=Native 2=Software 3=Compare (0 = never called)
            bw.vtxType = A[0x026B398C >> 2] >>> 0;
            bw.vtxCreate = A[0x026B3990 >> 2] >>> 0;       // CreateVertexLoader calls
            bw.vtxBuilt = A[0x026B3994 >> 2] >>> 0;        // VertexLoaderWasm constructed
            bw.vtxUnsup = A[0x026B3998 >> 2] >>> 0;        // IsSupported() rejections
            bw.cpDistLive = A[0x026B1AD8 >> 2] >>> 0;      // last CPReadWriteDistance seen by RunGpuLoop
            bw.gpReadEn = A[0x026B1AE4 >> 2] >>> 0;        // bFF_GPReadEnable seen by RunGpuLoop
            bw.gpfWrite32 = A[0x026B1AE8 >> 2] >>> 0;      // GPFifo::Write32 entries (WPAR reaching dolphin GPFifo?)
            bw.gpfFastWrite = A[0x026B1AF4 >> 2] >>> 0;    // reached FastWrite32 (past excursion-redirect)
            bw.gpfUpdate = A[0x026B1AF0 >> 2] >>> 0;       // UpdateGatherPipe entries (flush called?)
            bw.gpfBurst = A[0x026B1AEC >> 2] >>> 0;        // GatherPipeBursted -> CP FIFO bursts
            bw.cpLinkEn = A[0x026B1AF8 >> 2] >>> 0;        // bFF_GPLinkEnable (live, from UpdateGatherPipe)
            bw.rglOuter = A[0x026B1B10 >> 2] >>> 0;        // RunGpuLoop entered (before mainloop)
            bw.rglPastPull = A[0x026B1B18 >> 2] >>> 0;     // payload reached past PullEvents
            bw.waitForN = A[0x026B1B14 >> 2] >>> 0;        // Event::WaitFor poll entries (any Event)
            bw.emuRunning = A[0x026B1B1C >> 2] >>> 0;      // m_emu_running_state.IsSet() (GPU gate)
            bw.rglElse = A[0x026B1B20 >> 2] >>> 0;         // reached else-branch (past emu-running gate)
            // [dc-diag nonce 2026-07-22] split-memory decider (GPFifo.cpp CPU half / Fifo.cpp GPU half)
            bw.nonceCpuN = A[0x026B1BF0 >> 2] >>> 0;                     // CPU counter (shared region)
            bw.nonceCpuFifo0 = (A[0x026B1BF4 >> 2] >>> 0).toString(16);  // CPU raw read of fifo[0]
            bw.nonceGpuFifo0 = (A[0x026B1BF8 >> 2] >>> 0).toString(16);  // GPU raw read of fifo[0]
            bw.nonceGpuSeen = A[0x026B1BFC >> 2] >>> 0;                  // GPU re-read of CPU counter
            bw.dcInitDual = A[0x026B1BE0 >> 2] >>> 0;                    // Fifo::Init IsDualCoreMode (1=yes 2=no)
            bw.aramReqN = A[0x026B1BD0 >> 2] >>> 0;                      // ARAM DMA requests (Do_ARAM_DMA)
            bw.mailPopN = A[0x026B1BB0 >> 2] >>> 0;                      // DSP_MAIL_FROM_DSP_LO reads (mail pops)
            bw.maskedAramN = A[0x026B3004 >> 2] >>> 0;                   // completions with ARAM enable CLEAR
            bw.arqCb = (A[0x026B3220 >> 2] >>> 0).toString(16);          // guest __AR_Callback at last completion
            bw.mq45f4 = (A[0x026B3230 >> 2] >>> 0) + '/' + (A[0x026B3234 >> 2] >>> 0) + '/' + (A[0x026B3238 >> 2] >>> 0); // msgCount/first/used
            // [dist-diag] GPU {plain,rmw,addr} vs CPU {val,addr} distance views
            bw.distGpu3 = (A[0x026B3300 >> 2] >>> 0) + '/' + (A[0x026B3304 >> 2] >>> 0) + '/0x' + (A[0x026B3308 >> 2] >>> 0).toString(16);
            bw.distCpu2 = (A[0x026B3310 >> 2] >>> 0) + '/0x' + (A[0x026B3314 >> 2] >>> 0).toString(16);
            bw.rglExited = A[0x026B331C >> 2] >>> 0;                     // 1 = RunGpuLoop's mainloop returned
            // [perf-split] device-thread slice 0.1ms accum / slice count / CPU throttle-sleep 0.1ms accum
            bw.perfSplit = (A[0x026B3380 >> 2] >>> 0) + '/' + (A[0x026B3384 >> 2] >>> 0) + '/' + (A[0x026B3388 >> 2] >>> 0)
              + '/' + (A[0x026B3390 >> 2] >>> 0) + '/' + (A[0x026B3394 >> 2] >>> 0); // +advance 0.1ms/count
            // [slowmem-audit] slow-path host calls (ALL widths as of PM23) by class:
            // RAM-mirror(fastmem-eligible) / MMIO-other / GP / locked-L1 0xE0
            bw.slowmem = (A[0x026B33B0 >> 2] >>> 0) + '/' + (A[0x026B33B4 >> 2] >>> 0) + '/'
              + (A[0x026B33B8 >> 2] >>> 0) + '/' + (A[0x026B33BC >> 2] >>> 0);
            // [slowmem-class] runtime slow-arm executions by op family: integer / scalar-FP / (psq=remainder)
            bw.slowClass = (A[0x026B33C0 >> 2] >>> 0) + '/' + (A[0x026B33C4 >> 2] >>> 0) + '/' + (A[0x026B33C8 >> 2] >>> 0);
            // [simd-census TEMP] EMIT-TIME ps path census: simd-arith/scalar-arith/simd-fma/scalar-fma
            // + [single-spec] shadow mask (hex) + cumulative deopt count
            bw.simdCensus = (A[0x026B33D0 >> 2] >>> 0) + '/' + (A[0x026B33D4 >> 2] >>> 0) + '/'
              + (A[0x026B33D8 >> 2] >>> 0) + '/' + (A[0x026B33DC >> 2] >>> 0)
              // [madds-census STEP-1] EMIT-TIME ps_madds arm split: simd-madds / scalar-madds
              + ' madds=' + (A[0x026B33CC >> 2] >>> 0) + '/' + (A[0x026B33FC >> 2] >>> 0)
              // [WS-1 STEP-3] fp_resident_loop region-entry emit count
              + ' region=' + (A[0x026B3404 >> 2] >>> 0)
              + ' mask=0x' + (A[0x026B33E0 >> 2] >>> 0).toString(16)
              + ' deopt=' + (A[0x026B33E8 >> 2] >>> 0)
              + ' psWith=' + (A[0x026B33EC >> 2] >>> 0)
              + ' psWithout=' + (A[0x026B33F0 >> 2] >>> 0)
              + ' failBits=0x' + (A[0x026B33F8 >> 2] >>> 0).toString(16)
              + ' ring=' + Array.from({length: Math.min(32, A[0x026B33F4 >> 2] >>> 0)},
                  (_, k) => (A[(0x026B3400 >> 2) + k] >>> 0).toString(16)).join(',');
            // [seq-diag] shared seq: now / payload / burst / drain / sleep / mainloop-tick
            bw.seqs = (A[0x026B3320 >> 2] >>> 0) + '/' + (A[0x026B3324 >> 2] >>> 0) + '/' + (A[0x026B3328 >> 2] >>> 0)
              + '/' + (A[0x026B3330 >> 2] >>> 0) + '/' + (A[0x026B3334 >> 2] >>> 0) + '/' + (A[0x026B3338 >> 2] >>> 0);
            // [stage-diag] drain-body stages A(post-Read)/B(post-RunFifo)/C(post-Status)
            bw.stages = (A[0x026B3360 >> 2] >>> 0) + '/' + (A[0x026B3364 >> 2] >>> 0) + '/' + (A[0x026B3368 >> 2] >>> 0);
            // [stage-diag] the frozen chunk: 32 bytes of guest MEM1 at the GPU's last CPReadPointer
            bw.frozenChunk = (function() { var rp = A[0x026B1B40 >> 2] >>> 0, out = [];
              if (rp) for (var k = 0; k < 8; k++) out.push((rd32((0x80000000 + rp + k * 4) >>> 0) >>> 0).toString(16).padStart(8, '0'));
              return '0x' + rp.toString(16) + ': ' + out.join(' '); })();
            // [link-diag] CP CTRL write ring {val@pc}, oldest-first
            bw.ctrlRing = (function() { var h = A[0x026B3240 >> 2] >>> 0, out = [];
              for (var k = (h >= 16 ? h - 16 : 0); k < h; k++) { var e = (0x026B3250 + (k & 15) * 8) >> 2;
                out.push((A[e] >>> 0).toString(16) + '@' + (A[e + 1] >>> 0).toString(16)); }
              return out.join(' '); })();
            bw.arqQLo = (A[0x026B3224 >> 2] >>> 0).toString(16);         // guest __ARQRequestQueueLo
            bw.arqQHi = (A[0x026B3228 >> 2] >>> 0).toString(16);         // guest __ARQRequestQueueHi
            bw.complCtl = (A[0x026B3008 >> 2] >>> 0).toString(16);       // control Hex at last completion
            bw.cwTotal = A[0x026B2714 >> 2] >>> 0;                       // DSP_CONTROL writes
            bw.cwAramAck = A[0x026B2718 >> 2] >>> 0;                     // ...that ack ARAM
            // [aram-diag ring] last-32 DSP_CONTROL writes {val,pc,preHex,seq}, oldest-first
            bw.cwRing = (function() { var h = A[0x026B3000 >> 2] >>> 0, out = [];
              for (var k = (h >= 32 ? h - 32 : 0); k < h; k++) { var e = (0x026B3010 + (k & 31) * 16) >> 2;
                out.push((A[e] >>> 0).toString(16) + '@' + (A[e + 1] >>> 0).toString(16) + '/' + (A[e + 2] >>> 0).toString(16)); }
              return out.join(' '); })();
            bw.dspCauseSet = A[0x026B1BC0 >> 2] >>> 0;                   // PI INT_CAUSE_DSP 0->1 sets
            bw.dspCauseClr = A[0x026B1BCC >> 2] >>> 0;                   // PI INT_CAUSE_DSP 1->0 clears
            bw.extDelivN = A[0x026B1BC8 >> 2] >>> 0;                     // EXT delivery commits
            bw.extDelivDsp = A[0x026B1BC4 >> 2] >>> 0;                   // ...with DSP bit in cause
            bw.sleepPre = A[0x026B1BE4 >> 2] >>> 0;                      // BlockingLoop pre-wait heartbeat
            bw.sleepPost = A[0x026B1BE8 >> 2] >>> 0;                     // BlockingLoop post-wait heartbeat
            bw.cpIntWait = A[0x026B1B24 >> 2] >>> 0;       // command_processor.IsInterruptWaiting()
            bw.cpAtBp = A[0x026B1B28 >> 2] >>> 0;          // AtBreakpoint
            bw.cpDistGpu = A[0x026B1B30 >> 2] >>> 0;       // CPReadWriteDistance seen inside else-branch
            bw.rgocIter = A[0x026B1B34 >> 2] >>> 0;        // RunGpuOnCpu drain iterations (CPU-side drain)
            bw.sddDecodeNG = A[0x026B1B38 >> 2] >>> 0;     // NON-gated SETDRAWDONE decodes (FINISH reached decoder?)
            bw.cpDistGpuMax = A[0x026B1B3C >> 2] >>> 0;    // MAX CPReadWriteDistance GPU ever saw
            bw.cpRpGpu = (A[0x026B1B40 >> 2] >>> 0).toString(16);   // CPReadPointer (GPU view)
            bw.cpWpGpu = (A[0x026B1B44 >> 2] >>> 0).toString(16);   // CPWritePointer (GPU view)
            bw.fifoAddrGpu = (A[0x026B1B48 >> 2] >>> 0).toString(16); // &m_fifo from GPU thread
            bw.fifoAddrCpu = (A[0x026B1B4C >> 2] >>> 0).toString(16); // &m_fifo from CPU/guest thread
            bw.cpRpCpu = (A[0x026B1B50 >> 2] >>> 0).toString(16);   // CPReadPointer (CPU view)
            bw.cpBaseCpu = (A[0x026B1B54 >> 2] >>> 0).toString(16); // CPBase (CPU view)
            bw.jitwasmRun = A[0x026B1B58 >> 2] >>> 0;      // dolphin EmuThread JitWasm::Run iters (guest on dolphin?)
            bw.gpRingDrain = A[0x026B1B5C >> 2] >>> 0;     // GP-ring non-empty events (guest on ppc-worker?)
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

  // [vtx A/B 2026-08-29] Per-arm medians of the interleaved pair. Median, not
  // mean: one GC pause or one scheduler steal from a co-tenant probe skews a mean
  // of ~30 samples badly, and the arms are compared to each other, not to an
  // absolute. renderCap and guestCap are reported SEPARATELY because `cap` is
  // min() of the two and hides which stage actually bound the window.
  if (process.env.PROBE_VTX_AB_MS) {
    try {
      const ab = await page.evaluate(() => (window.__vtxAB ? window.__vtxAB.rows : null));
      if (!ab || !ab.length) {
        console.log('[vtxAB] NO SAMPLES — arm never ran (check PROBE_VTX_AB_START_MS vs duration)');
      } else {
        const med = (a) => { const v = a.filter((x) => x !== null && x !== undefined).sort((p, q) => p - q);
          return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
        const fmt = (v) => (v === null ? 'null' : v.toFixed(2));
        const out = { samples: ab.length };
        for (const arm of [0, 1]) {
          const rows = ab.filter((r) => r.arm === arm);
          const name = arm === 0 ? 'A_wasm' : 'B_software';
          out[name] = { n: rows.length,
            renderCap: med(rows.map((r) => r.rcap)), guestCap: med(rows.map((r) => r.gcap)),
            cap: med(rows.map((r) => r.cap)), speed: med(rows.map((r) => r.speed)) };
          console.log('[vtxAB] ' + name + ' n=' + rows.length
            + ' renderCap=' + fmt(out[name].renderCap) + ' guestCap=' + fmt(out[name].guestCap)
            + ' cap=' + fmt(out[name].cap) + ' speed=' + fmt(out[name].speed));
        }
        // VALIDITY GATE. Each arm must actually be served by the path it names:
        // arm A must ADVANCE the emitted-draw counter and not the fallback one,
        // arm B the reverse. A pair that fails this is comparing software to
        // software (the loader-cache trap) and its ratio means nothing — this
        // exact failure produced a plausible-looking 0.993x before the counters
        // existed to catch it.
        const dA = { emit: 0, fall: 0 }, dB = { emit: 0, fall: 0 };
        for (let i = 1; i < ab.length; i++) {
          const d = ab[i].arm === 0 ? dA : dB;
          if (ab[i].arm !== ab[i - 1].arm) continue;   // only within-arm deltas
          d.emit += ab[i].emit - ab[i - 1].emit;
          d.fall += ab[i].fall - ab[i - 1].fall;
        }
        console.log('[vtxAB] within-arm draw deltas: A_wasm emit=' + dA.emit + ' fall=' + dA.fall
          + ' | B_software emit=' + dB.emit + ' fall=' + dB.fall);
        const valid = dA.emit > 0 && dA.fall === 0 && dB.fall > 0 && dB.emit === 0;
        console.log('[vtxAB] VALIDITY: ' + (valid ? 'PASS — each arm ran its own code path'
          : 'FAIL — arms did not run distinct code paths; ratio is MEANINGLESS'));
        const a = out.A_wasm.renderCap, b = out.B_software.renderCap;
        if (a && b && valid) console.log('[vtxAB] renderCap A_wasm/B_software = ' + (a / b).toFixed(3) + 'x');
        const last = ab[ab.length - 1];
        console.log('[vtxAB] cumulative emitted-draws=' + last.emit + ' fallback-draws=' + last.fall
          + ' wasmLoadersBuilt=' + last.built);
        console.log('[vtxAB] rows=' + JSON.stringify(ab));
      }
    } catch (e) { console.log('[vtxAB] dump failed: ' + e.message); }
  }

  // [generic ablation A/B 2026-08-29] per-arm medians + the validity gate.
  if (typeof global.__abReport === 'function') { try { await global.__abReport(); } catch (_e) {} }

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
