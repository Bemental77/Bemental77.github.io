// Headless boot probe for the Flycast WASM port.
//
// Serves the repo over a COOP/COEP local HTTP server, launches Chrome
// headless, loads dreamcast.html, auto-clicks the Start button, and
// captures the SIGNAL lines (everything `[flycast-shim]`, `[flycast-worker]`,
// `[flycast.log]`, `[flycast-funcs]`, `[flycast-wasm]`, `[page]`, plus any
// abort / uncaught wasm error) — silently drops the emcc DEBUG/ASSERTIONS
// stream (`flycast_worker_emcc.js:NNN` lines + `w:N,t:0xNNN: ...` dbg() noise)
// which currently floods the console with 50+ benign entries per boot.
//
// Exits early on:
//   - `[page] worker ready` not seen within --idle-ms ms after page load
//   - ABORT detected
//   - "load_disc:" success or fail
//   - any successful video_cb frame
//
// Usage:
//   node dreamcast/tools/flycast_probe.js [--duration 30000] [--no-start]
//                                         [--idle 8000] [--keep-noise]
//   PROBE_LOG=/tmp/dc.log node dreamcast/tools/flycast_probe.js
//
// Env:
//   FLYCAST_V8_FLAGS — forwarded verbatim to the headless Chrome instance
//                      as `--js-flags=<value>`. Use to tune V8 wasm
//                      behaviour (e.g. `--trace-deopt --print-wasm-code`,
//                      `--no-liftoff`, `--wasm-tier-up`). The probe itself
//                      runs under whichever node binary invoked it — these
//                      flags affect the Chromium renderer's V8, not node.
//
// Exits 0 on clean shutdown, 1 on probe-detected fatal abort.

const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const puppeteer = require('puppeteer');

// Artifact hash-guard. Every probe result is only as good as the binary it ran
// against, and the two ways this rig has produced false results are (a) a stale
// archive that never reached the link and (b) a concurrent relink landing
// mid-run. Hashing the served wasm before and after the run turns both into a
// visible line instead of a silent wrong number.
const ARTIFACTS = [
  'dreamcast/flycast_libretro/flycast_worker_emcc.wasm',
  'dreamcast/flycast_libretro/flycast_worker_emcc.js',
];
function hashArtifacts(root) {
  const out = [];
  for (const rel of ARTIFACTS) {
    const p = path.join(root, rel);
    try {
      const st = fs.statSync(p);
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      out.push({ rel, sha256: h, size: st.size, mtime: st.mtimeMs });
    } catch (e) {
      out.push({ rel, sha256: 'MISSING', size: 0, mtime: 0 });
    }
  }
  return out;
}

// Repo root, derived — no hardcode. PROBE_ROOT overrides it so this probe can
// be pointed at the DEPLOY tree (Bemental77.github.io) instead of the build
// tree: reproducing a user-reported bug means serving the bytes the user's
// device actually downloads, and it also dodges the hash-guard tripping when a
// concurrent session relinks the build tree mid-run.
const ROOT = process.env.PROBE_ROOT
  ? path.resolve(process.env.PROBE_ROOT)
  : path.resolve(__dirname, '..', '..');
// DC-owned port (GC uses 8080/8789). `let`, not `const`: when several probes
// run concurrently the first one owns 8790 and every later one died on
// EADDRINUSE before it served a byte. startServer() now walks forward to the
// next free port and the page URL is built from the port it actually got.
let PORT = parseInt(process.env.PROBE_PORT || '8790', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// --- argv ---
let DURATION_MS = parseInt(process.env.PROBE_DURATION_MS || '30000', 10);
let AUTO_START = true;
// Track3.bin is 1.18 GB and streams silently for ~8–12s on a warm filesystem
// before its post-write log line fires. 20s default tolerates that.
let IDLE_MS = parseInt(process.env.PROBE_IDLE_MS || '20000', 10);
let KEEP_NOISE = false;
let LOG_PATH = process.env.PROBE_LOG || '';
let INTERP_ONLY = false;
let NO_FASTMEM = false;
let NOIC = false;
let SHARD_ON = false;      // lever-6D: ?shard=1 (explicit-on; shard is default ON post-cert)
let NOSHARD = false;       // lever-6 cert: --noshard — matched-pair baseline arm
let NOARM7JIT = false;     // lever-7: --noarm7jit — v0 interpret-runner baseline arm
let ARM7SELFTEST = false;  // lever-7: --arm7selftest — per-block jit-vs-interp compare
let EXTRA_QUERY = '';      // --q "<raw params>" appended to the page URL verbatim
let UNCAP = false;         // --uncap: disable the real-time governor (throughput/perf probes)
let PRESSES = [];          // --press "<ms>:<Key>:<holdMs>" (repeatable) — timed puppeteer key holds
let SERVE_ONLY = false;    // --serve — dev server only (no puppeteer); Ctrl+C to stop
let MID_SHOTS_MS = [];     // lever-4: --midshot <ms> (repeatable) — timed screenshots during the run
// Navigation filmstrip (2026-08-29). Driving the guest to a NAMED SCENE with
// --press is blind: a single mid-run shot cannot distinguish "the character
// did not move" from "the character moved and came back", and two 2 s holds
// that produced byte-different-but-visually-identical frames burned a whole
// run before the difference was legible. --shotevery lays down a regular
// canvas-only strip so a trajectory is READ, not inferred; --canvasonly drops
// the shell companion, which halves the wall time each shot steals from the run.
let SHOT_EVERY = 0;        // --shotevery <ms>: periodic canvas shot, 0 = off
let SHOT_FROM  = 0;        // --shotfrom <ms>: don't start the strip before this
let CANVAS_ONLY = false;   // --canvasonly: skip the #wrap/shell companion shot
let PARITY = 0;            // lever-4 task 6: --parity <frames> — run the IC parity gate
let PARITY_MS = 0;         // --parityms <ms> — when to fire it (default page-side 70s)
let PARITY_FROM = '';      // lever-6 cert: --parityfrom load — replay the autoloaded state.bin
let PROF_AT = 0;           // lever-5: --profat <ms> — start a CPU profile of the emu worker
let PROF_DUR = 20000;      // --profdur <ms> — profile duration (default 20s)
let SAVESTATE_PATH = '';   // --savestate <file> (+ --savems <ms>): capture a state via PUT /state.bin
let SAVE_MS = 0;
// Multi-checkpoint capture (2026-08-29). Driving the guest to a named scene is
// a CLOSED-LOOP problem — you can only pick the next move after seeing where
// the last one left you — but one run yields exactly one autosave, so a run
// that passed through a good spot and then walked out of it saved the walk-out.
// --saveat clicks the page's own Save State button at each given time; the PUT
// handler numbers the files, and a matching screenshot is taken at the same
// instant, so every checkpoint has an image and a run becomes N candidate
// resume points instead of one. Requires --savestate (the PUT sink) and a
// --savems past the run end (the page only PUTs when ?autosave is on the URL).
let SAVE_ATS = [];         // --saveat <ms> (repeatable)
let saveSeq = 0;           // PUTs received so far, for the filename suffix
let MULTI_SAVE = false;    // set once after argv; SAVE_ATS is drained by the driver
let LOADSTATE_PATH = '';   // --loadstate <file>: serve it at GET /state.bin; page auto-loads (&autoload=1)
let NO_REGCACHE = false;
let NO_IMMFAST = false;
let INTERP_RANGE = '';
let PC_TRACE_UNTIL = 0;
let SCREENSHOT_PATH = '';
let PEEK_SPEC = '';
let PEEK_MS = 0;
let CTXSNAP = false;
let NOCHAIN = false;
let IDLESKIP = false;      // --idleskip: lever-11 v0 frame-wait-spin slice burn
let RTEINTC = false;
let CTX_MS = 0;
// --vblsettle <ms>: how much of the run to exclude from the SETTLED vblank
// window. The boot ramp is not steady state — the guest runs ~0.5x for the
// first second, video_cb is nearly all dupes, and sh4_sched_now64() takes a
// one-shot step in there. 15 s clears PSO's boot on this rig with margin.
let VBL_SETTLE_MS = parseInt(process.env.PROBE_VBL_SETTLE_MS || '15000', 10);
// --- mobile arm (2026-08-28) ---------------------------------------------
// The page has a whole second code path — #mobileShell, the touch pad, the
// splash Start — that no probe had EVER executed. `--mobile` turns on
// puppeteer device emulation (mobile UA + touch + phone viewport/DPR) so the
// page's own isMobile sniff (dreamcast.html:1531) takes the mobile branch,
// and drives Start with a REAL touch tap, because the splash Start is bound
// to `pointerdown` + preventDefault() (dreamcast.html:1564-1571) — a DOM
// .click() dispatches only a `click` event and is silently swallowed.
//
// THIS IS NOT A PHONE. It emulates viewport, DPR, touch and UA. It does NOT
// emulate the GPU driver, the memory ceiling, or thermal throttling.
let MOBILE = false;
let MOBILE_DEVICE = 'iPhone 13 Pro landscape';  // --device "<KnownDevices name>"
let MOBILE_FORCE = false;  // --mobileforce: append &mobile=1 instead of trusting the sniff
let SWGL = false;          // --swgl: SwiftShader (software GL) arm — weak-GPU proxy, NOT a phone GPU
let SHOTDIR = '';          // --shotdir <dir>: write the mobile shot series here
// --rotate <ms>: flip the emulated viewport's orientation at T. The page's
// rotate overlay (#rotateHint, a full-screen #111 at z-index 3000) is driven
// ONLY by checkOrientation(), and checkOrientation() is wired to exactly two
// things (dreamcast.html:1570 at splash-start, :1614 window 'resize') — there
// is no orientationchange / screen.orientation listener. So "does the overlay
// clear when you turn the phone" is a real, testable question.
let ROTATE_MS = 0;
// --- isolation arms (2026-09-01) -----------------------------------------
// THE DEPLOYED ISOLATION MECHANISM WAS NEVER ONCE EXERCISED LOCALLY.
// startServer() sets COOP/COEP itself (see below), so `crossOriginIsolated`
// is true on this rig before /coi-serviceworker.js does anything at all. On
// GitHub Pages there are no such headers — the service worker IS the whole
// mechanism, and every configuration that blocks it (private window, blocked
// storage, an extension) is a configuration this probe could not reach.
//
//   --nocoiheaders  serve WITHOUT COOP/COEP, exactly like GitHub Pages, so
//                   the real service-worker path runs and its reload round
//                   trip is measured rather than assumed.
//   --noswa         additionally delete navigator.serviceWorker before any
//                   page script runs, which is what a private window looks
//                   like from inside the page. Exercises the bounded reload
//                   and the hard-stop panel that must follow it.
let NO_COI_HEADERS = false;
let NO_SW = false;
// --- progress sampling ---------------------------------------------------
// Polls window.__dcProbe() (dreamcast.html) so the summary can say BOOTING or
// BROKEN from a counter instead of from a screenshot. A wedged run screenshots
// a plausible frame; a healthy mid-download run screenshots black. The picture
// is not evidence in either direction — `seq` is.
let PROG_MS = parseInt(process.env.PROBE_PROG_MS || '2000', 10);
// --stallpart <n>: the Nth disc-part request sends its headers and ~1 MB and
// then goes silent forever, without closing the socket. That is what a phone
// losing its connection mid-download actually looks like to fetch(), and it is
// the ONLY way to exercise the page's inter-chunk watchdog and its "the
// download stopped" panel. An error handler nobody has ever fired is not a
// safety net; this is how that one gets fired. Pair with --q netgrace=10 so
// the run does not have to sit through the 45 s production budget.
let STALL_PART = 0;
let stallPartSeen = 0;
// --allocfail <MB>: make any typed-array allocation of at least <MB> throw, in
// the page realm, before any page script runs. This is a stand-in for the iOS
// per-tab memory ceiling — the one hard constraint device emulation does NOT
// reproduce. It cannot tell us WHERE a real iPhone's ceiling is; it can only
// prove what this page does when it hits one, which was previously unknown and
// unknowable without the phone.
let ALLOC_FAIL_MB = 0;
// --noglctx: Chrome's --disable-3d-apis, which removes WebGL from the PAGE AND
// THE WORKER (a page-realm override cannot reach the worker's context, and the
// worker's is the one that renders). Proves what the page does on a device with
// no usable WebGL2 — previously that produced a black canvas behind a UI that
// still looked alive, with the explanation only in the diagnostics panel.
let NO_GL = false;
// --noworkergl: the ONLY way to reach the worker's GL realm from here. The
// worker script is served by this process, so a prelude is prepended to it that
// makes OffscreenCanvas.getContext('webgl2') return null INSIDE THE WORKER.
// Chrome's --disable-3d-apis does not reach it: measured 2026-09-01, that arm
// left the page probe reporting no-WebGL2 while the worker rendered at 30 fps.
// Without this, the page's terminal "no graphics context" stop is unprovable.
let NO_WORKER_GL = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--duration')   DURATION_MS = parseInt(process.argv[++i], 10);
  else if (a === '--idle')  IDLE_MS = parseInt(process.argv[++i], 10);
  else if (a === '--no-start') AUTO_START = false;
  else if (a === '--keep-noise') KEEP_NOISE = true;
  else if (a === '--log')   LOG_PATH = process.argv[++i];
  else if (a === '--interp') INTERP_ONLY = true;
  else if (a === '--nofastmem') NO_FASTMEM = true;
  else if (a === '--noic') NOIC = true;
  else if (a === '--shard') SHARD_ON = true;
  else if (a === '--noshard') NOSHARD = true;
  else if (a === '--noarm7jit') NOARM7JIT = true;
  else if (a === '--arm7selftest') ARM7SELFTEST = true;
  else if (a === '--q') EXTRA_QUERY = process.argv[++i];   // raw extra query params, e.g. --q "nofog=1&nomodvol=1"
  else if (a === '--uncap') UNCAP = true;                  // throughput probes: governor OFF (historical free-run)
  else if (a === '--press') {                              // e.g. --press 40000:ArrowUp:3000
    const m = /^(\d+):([^:]+):(\d+)$/.exec(process.argv[++i] || '');
    if (m) PRESSES.push({ at: +m[1], key: m[2], hold: +m[3] });
    else console.error('bad --press spec (want <ms>:<Key>:<holdMs>)');
  }
  else if (a === '--serve') SERVE_ONLY = true;
  else if (a === '--midshot') MID_SHOTS_MS.push(parseInt(process.argv[++i], 10) >>> 0);
  else if (a === '--shotevery') SHOT_EVERY = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--shotfrom') SHOT_FROM = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--canvasonly') CANVAS_ONLY = true;
  else if (a === '--parity') PARITY = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--parityms') PARITY_MS = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--parityfrom') PARITY_FROM = process.argv[++i];
  else if (a === '--profat') PROF_AT = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--profdur') PROF_DUR = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--savestate') SAVESTATE_PATH = process.argv[++i];
  else if (a === '--savems') SAVE_MS = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--saveat') SAVE_ATS.push(parseInt(process.argv[++i], 10) >>> 0);
  else if (a === '--loadstate') LOADSTATE_PATH = process.argv[++i];
  else if (a === '--noregcache') NO_REGCACHE = true;
  else if (a === '--noimmfast') NO_IMMFAST = true;
  else if (a === '--interprange') INTERP_RANGE = process.argv[++i];
  else if (a === '--pctrace') PC_TRACE_UNTIL = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--screenshot') SCREENSHOT_PATH = process.argv[++i];
  else if (a === '--peek') PEEK_SPEC = process.argv[++i];
  else if (a === '--peekms') PEEK_MS = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--ctxsnap') CTXSNAP = true;
  else if (a === '--nochain') NOCHAIN = true;
  else if (a === '--idleskip') IDLESKIP = true;   // lever-11 v0: frame-wait-spin slice burn
  else if (a === '--rteintc') RTEINTC = true;
  else if (a === '--ctxms') CTX_MS = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--vblsettle') VBL_SETTLE_MS = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--mobile') MOBILE = true;
  else if (a === '--device') { MOBILE = true; MOBILE_DEVICE = process.argv[++i]; }
  else if (a === '--mobileforce') { MOBILE = true; MOBILE_FORCE = true; }
  else if (a === '--swgl') SWGL = true;
  else if (a === '--shotdir') SHOTDIR = process.argv[++i];
  else if (a === '--rotate') { MOBILE = true; ROTATE_MS = parseInt(process.argv[++i], 10) >>> 0; }
  else if (a === '--nocoiheaders') NO_COI_HEADERS = true;
  else if (a === '--noswa') { NO_SW = true; NO_COI_HEADERS = true; }
  else if (a === '--progms') PROG_MS = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--stallpart') STALL_PART = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--allocfail') ALLOC_FAIL_MB = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--noglctx') NO_GL = true;
  else if (a === '--noworkergl') NO_WORKER_GL = true;
  else if (a === '-h' || a === '--help') {
    console.log('flycast_probe [--duration MS] [--idle MS] [--no-start] [--keep-noise] [--log PATH] [--interp] [--pctrace N]');
    console.log('  mobile arm: [--mobile] [--device "<KnownDevices name>"] [--mobileforce] [--swgl] [--shotdir DIR]');
    console.log('  --mobile emulates viewport/DPR/touch/UA only. It does NOT emulate a phone GPU driver,');
    console.log('  a phone memory ceiling, or thermal throttling. "mobile probe passed" != "works on a phone".');
    console.log('  isolation:  [--nocoiheaders]  serve without COOP/COEP (as GitHub Pages does) so the');
    console.log('                               real /coi-serviceworker.js path is what gets tested');
    console.log('              [--noswa]         also hide navigator.serviceWorker (a private window)');
    console.log('  liveness:   [--progms MS]     poll window.__dcProbe() (default 2000)');
    process.exit(0);
  }
}

MULTI_SAVE = SAVE_ATS.length > 0;   // latched before the driver drains SAVE_ATS

// --- MIME ---
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.bin': 'application/octet-stream', '.cue': 'text/plain', '.iso': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // COOP/COEP — required for SharedArrayBuffer.
      //
      // Sending these makes the rig UNLIKE the deploy: GitHub Pages sends no
      // such headers, so on caseybement.com /coi-serviceworker.js is the only
      // thing that produces isolation. --nocoiheaders drops them so the real
      // mechanism is what runs. (The service worker still needs its own
      // Service-Worker-Allowed scope-free registration at the root, which this
      // server satisfies because it serves /coi-serviceworker.js from ROOT.)
      if (!NO_COI_HEADERS) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      }
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      // Savestate fast-path (lever-6 tooling): the page PUTs a captured state
      // here; later runs GET it and jump straight to the scene (boot skipped).
      if (urlPath === '/state.bin' && req.method === 'PUT' && SAVESTATE_PATH) {
        // One file per PUT when --saveat is in play, so a run's checkpoints do
        // not overwrite each other; plain --savems keeps the exact given path.
        const outPath = MULTI_SAVE
          ? SAVESTATE_PATH.replace(/(\.[^./]*)?$/, (ext) =>
              '-' + String(++saveSeq).padStart(2, '0') + (ext || ''))
          : SAVESTATE_PATH;
        const ws = fs.createWriteStream(outPath);
        req.pipe(ws);
        ws.on('finish', () => {
          console.log('[probe] savestate captured -> ' + outPath);
          res.statusCode = 200; res.end('ok');
        });
        ws.on('error', () => { res.statusCode = 500; res.end('err'); });
        return;
      }
      if (urlPath === '/state.bin' && LOADSTATE_PATH) {
        fs.stat(LOADSTATE_PATH, (err, stat) => {
          if (err) { res.statusCode = 404; res.end('404'); return; }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', stat.size);
          fs.createReadStream(LOADSTATE_PATH).pipe(res);
        });
        return;
      }
      if (urlPath === '/') urlPath = '/dreamcast.html';
      // --stallpart: hang the Nth disc-part response mid-body. Headers and a
      // first slice go out, then nothing, and the socket is deliberately left
      // open — a closed socket would reject the fetch() promise, which the page
      // already handles. The untested case is the one that never settles.
      if (STALL_PART && /Track\d\.bin\.part/.test(urlPath) && ++stallPartSeen === STALL_PART) {
        console.log('[probe] STALL INJECTED on disc part #' + stallPartSeen + ' (' + urlPath +
          ') — headers + 1 MB, then permanent silence with the socket held open');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', 99614720);   // claim the full part
        res.write(Buffer.alloc(1048576));            // 1 MB, then never again
        return;                                      // no res.end(), ever
      }
      // --noworkergl: rewrite the worker script on the way out. Prepending is
      // safe for the page's capability probe, which fetches this same URL and
      // greps it for 'heapAlloc' / 'discLazy' — the prelude adds text, removes
      // none.
      if (NO_WORKER_GL && /flycast_worker\.js$/.test(urlPath)) {
        const src = fs.readFileSync(path.join(ROOT, urlPath), 'utf8');
        const prelude = ';(function(){try{var P=self.OffscreenCanvas&&self.OffscreenCanvas.prototype;' +
          'if(P){var g=P.getContext;P.getContext=function(t){' +
          'if(String(t).indexOf("webgl")===0){return null;}' +
          'return g.apply(this,arguments);};}}catch(e){}})();\n';
        const body = Buffer.from(prelude + src, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Content-Length', body.length);
        res.end(body);
        return;
      }
      const filePath = path.join(ROOT, urlPath);
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) { res.statusCode = 404; res.end('404'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        // Byte ranges. GitHub Pages serves them; this server did not, so
        // preflightRanges() (dreamcast.html) got a 200 where it demands a 206
        // and ?lazydisc=1 ALWAYS fell back to the eager path here — the one
        // documented escape hatch for the memory failure mode could not be
        // tested on this rig at all. Single-range only, which is all the page
        // and the worker's range reader ever ask for.
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
        if (range) {
          let s = range[1] === '' ? NaN : parseInt(range[1], 10);
          let e = range[2] === '' ? NaN : parseInt(range[2], 10);
          if (isNaN(s)) { s = stat.size - (isNaN(e) ? stat.size : e); e = stat.size - 1; }
          if (isNaN(e) || e >= stat.size) e = stat.size - 1;
          if (!(s >= 0) || s > e) {
            res.statusCode = 416;
            res.setHeader('Content-Range', 'bytes */' + stat.size);
            res.end(); return;
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', 'bytes ' + s + '-' + e + '/' + stat.size);
          res.setHeader('Content-Length', e - s + 1);
          res.setHeader('Accept-Ranges', 'bytes');
          fs.createReadStream(filePath, { start: s, end: e }).pipe(res);
          return;
        }
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(filePath).pipe(res);
      });
    });
    // Walk forward past a busy port (concurrent probes) instead of throwing an
    // unhandled 'error' event. Bounded so a genuinely broken bind still fails.
    let tries = 0;
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && ++tries <= 20) {
        PORT++;
        srv.listen(PORT, '127.0.0.1');
      } else {
        throw e;
      }
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// --- PNG pixel analysis --------------------------------------------------
// The user's report is a COLOUR claim ("black and green screen"), so the
// screenshots have to be measured, not eyeballed. Chrome's captureScreenshot
// emits non-interlaced 8-bit RGB/RGBA, which zlib + the 5 PNG filters decode
// in a few lines — no dependency, and it makes "did the canvas render" a
// number instead of an opinion.
const zlib = require('zlib');
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6))
    throw new Error(`unsupported PNG (depth=${depth} ctype=${ctype} interlace=${interlace})`);
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.slice(p, p + stride); p += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const A = x >= bpp ? cur[x - bpp] : 0;
      const B = prev ? prev[x] : 0;
      const C = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += A;
      else if (f === 2) v += B;
      else if (f === 3) v += (A + B) >> 1;
      else if (f === 4) {
        const pp = A + B - C, pa = Math.abs(pp - A), pb = Math.abs(pp - B), pc = Math.abs(pp - C);
        v += (pa <= pb && pa <= pc) ? A : (pb <= pc ? B : C);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, px: out };
}
// Reduce a screenshot to the handful of numbers that answer the user's claim.
function analyzePng(buf) {
  const { w, h, bpp, px } = decodePng(buf);
  let n = 0, sr = 0, sg = 0, sb = 0, black = 0, greenDom = 0;
  const colors = new Set();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * bpp;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      n++; sr += r; sg += g; sb += b;
      if (r < 12 && g < 12 && b < 12) black++;
      // "green screen": G clearly dominant and actually bright.
      if (g > 40 && g > r * 1.6 && g > b * 1.6) greenDom++;
      if (colors.size < 4096) colors.add((r << 16) | (g << 8) | b);
    }
  }
  const pct = (v) => +(100 * v / n).toFixed(2);
  return {
    w, h,
    meanR: +(sr / n).toFixed(1), meanG: +(sg / n).toFixed(1), meanB: +(sb / n).toFixed(1),
    blackPct: pct(black), greenDomPct: pct(greenDom),
    distinctColors: colors.size >= 4096 ? '>=4096' : colors.size,
  };
}
function fmtShot(tag, a) {
  return `[shot] ${tag} ${a.w}x${a.h} mean(rgb)=${a.meanR}/${a.meanG}/${a.meanB} ` +
         `black=${a.blackPct}% greenDominant=${a.greenDomPct}% colors=${a.distinctColors}`;
}

// --- noise filter ---
// Emcc's dbg() writes to console.error; under -sASSERTIONS=1 + -sGL_DEBUG=1
// it's prolific and not useful for bringup. Suppress unless --keep-noise.
function isNoise(text) {
  if (KEEP_NOISE) return false;
  // emcc dbg() format: "w:0,t:0x00000000: <message>"
  if (/^w:\d+,t:0x[0-9a-f]+:/i.test(text)) return true;
  // emcc thread bootstrap noise.
  if (/Worker Created$/.test(text)) return true;
  if (/installer proxying handler:/.test(text)) return true;
  if (/run\(\) called, but dependencies remain/.test(text)) return true;
  if (/(initRuntime|writeStackCookie|checkStackCookie|preMain|postRun|runtimeKeepalive|maybeExit|handleException|locateFile|asynchronously preparing wasm|preloading (files|data files)|done preloading|proc_exit|user callback done)/i.test(text)) return true;
  // mprotect cosmetic warnings from Sh4Recompiler::Reset.
  if (/unsupported syscall: __syscall_mprotect/.test(text)) return true;
  return false;
}

// Lines that signal a meaningful state transition.
function classify(text) {
  if (/\[flycast-shim\] ABORT:|RuntimeError|Uncaught/.test(text)) return 'fatal';
  if (/load_disc threw|load_disc: retro_load_game returned false/.test(text)) return 'fatal';
  if (/load_disc: retro_load_game returned true/.test(text))      return 'milestone';
  if (/hw_render\.context_reset returned/.test(text))             return 'milestone';
  if (/SET_HW_RENDER captured/.test(text))                        return 'milestone';
  if (/WebGL2 ctx ok/.test(text))                                 return 'milestone';
  if (/\[page\] worker ready/.test(text))                         return 'milestone';
  if (/video_cb /.test(text))                                     return 'frame';
  return null;
}

(async () => {
  const srv = await startServer();
  console.log('[probe] server up on :' + PORT);

  // Hash-guard, opening half. Printed before Chrome launches, so the digest in
  // the log is provably the bytes this run was served.
  const hashPre = hashArtifacts(ROOT);
  for (const a of hashPre)
    console.log('[probe] artifact ' + a.rel + ' sha256=' + a.sha256.slice(0, 16) +
                ' size=' + a.size + ' mtime=' + new Date(a.mtime).toISOString());

  // --serve: dev-server mode for interactive testing in a real browser.
  // Same server (COOP/COEP headers for SharedArrayBuffer, /state.bin
  // save/load endpoints when --savestate/--loadstate are given), no
  // puppeteer, no duration timer — Ctrl+C to stop.
  if (SERVE_ONLY) {
    console.log('[serve] open  http://127.0.0.1:' + PORT + '/dreamcast.html');
    console.log('[serve] toggles: ?diag=1  ?noshard=1  ?noarm7jit=1  ?arm7selftest=1  ?noic=1');
    if (LOADSTATE_PATH)
      console.log('[serve] jump-state: add  &autoload=1   (serving ' + LOADSTATE_PATH + ')');
    if (SAVESTATE_PATH)
      console.log('[serve] capture:    add  &autosave=<ms> (PUT -> ' + SAVESTATE_PATH + ')');
    console.log('[serve] Ctrl+C to stop');
    await new Promise(() => {});   // hold forever
    return;
  }

  const chromeArgs = [
    '--no-sandbox',
    '--enable-features=SharedArrayBuffer',
    // Headless Chromium throttles RAF/setInterval in non-visible windows,
    // which freezes the page's frameLoop after a few ticks. These three
    // flags keep the page running at full speed even when offscreen.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // BOUND THE DISK CACHE. Every run downloads a 1.13 GB disc, and Chrome will
    // happily write all of it into the throwaway profile — one arm per gigabyte,
    // in a temp directory that only gets removed on a CLEAN exit. A matrix of a
    // dozen arms with any interrupted run among them fills the volume, which is
    // how this rig hit ENOSPC on 2026-09-01. The server is local; a cache miss
    // costs nothing here.
    '--disk-cache-size=33554432',
  ];
  const V8_FLAGS = (process.env.FLYCAST_V8_FLAGS || '').trim();
  if (V8_FLAGS) {
    chromeArgs.push('--js-flags=' + V8_FLAGS);
    console.log('[probe] V8 flags: ' + V8_FLAGS);
  }
  if (NO_GL) {
    chromeArgs.push('--disable-3d-apis');
    console.log('[probe] NO-WEBGL ARM: --disable-3d-apis (page AND worker have no WebGL at all)');
  }
  if (SWGL) {
    // Software rasteriser arm. This is a DIFFERENT GL implementation, not a
    // phone GPU — useful only as "does the renderer depend on this desktop
    // driver's slack" evidence.
    chromeArgs.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    console.log('[probe] GL: SwiftShader (software) — a weak-driver proxy, NOT a phone GPU');
  }
  // FRESH PROFILE, EXPLICITLY, AND SAID OUT LOUD.
  //
  // Cross-origin isolation is ORIGIN-SCOPED and STICKY: once /coi-serviceworker.js
  // is registered for 127.0.0.1:<port>, every later page on that origin is
  // isolated from the service worker's cache before it runs a line of its own
  // code. A matrix run on one profile therefore measures the FIRST arm twelve
  // times and returns twelve identical rows — which is exactly what happened on
  // the live-site matrix that preceded this change. Puppeteer's default is
  // already a throwaway directory, but "already" is not a guarantee anybody can
  // read off a log, so the directory is created here, named in the log, and
  // deleted at exit. The isolation arms below are meaningless without it.
  const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dcx-profile-'));
  console.log('[probe] fresh browser profile: ' + PROFILE_DIR +
    ' (no service worker, cache or storage carries in from any earlier arm)');
  if (NO_COI_HEADERS)
    console.log('[probe] ISOLATION ARM: server sends NO COOP/COEP — /coi-serviceworker.js ' +
      'must produce cross-origin isolation on its own, as it does on GitHub Pages');
  if (NO_SW)
    console.log('[probe] ISOLATION ARM: navigator.serviceWorker hidden from the page ' +
      '(what a private window / blocked-storage configuration looks like from inside)');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: chromeArgs,
    userDataDir: PROFILE_DIR,
    dumpio: !!process.env.FLYCAST_DUMPIO,  // tee Chrome stderr (V8 --print-wasm-code) into our stdout
  });
  const page = await browser.newPage();
  if (ALLOC_FAIL_MB) {
    console.log('[probe] MEMORY-CEILING ARM: typed-array allocations >= ' + ALLOC_FAIL_MB +
      ' MB will throw in the page realm (a stand-in for the iOS per-tab ceiling; ' +
      'it proves the page\'s BEHAVIOUR at a ceiling, not where a real iPhone\'s ceiling is)');
    await page.evaluateOnNewDocument((limitMB) => {
      const limit = limitMB * 1048576;
      const wrap = (Ctor) => new Proxy(Ctor, {
        construct(t, args, nt) {
          if (typeof args[0] === 'number' && args[0] * (t.BYTES_PER_ELEMENT || 1) >= limit)
            throw new RangeError('Array buffer allocation failed');
          return Reflect.construct(t, args, nt);
        },
      });
      try { window.Uint8Array = wrap(Uint8Array); } catch (_) {}
      try { window.ArrayBuffer = wrap(ArrayBuffer); } catch (_) {}
    }, ALLOC_FAIL_MB);
  }
  if (NO_SW) {
    // Before ANY page script. The page's COI gate reads self.crossOriginIsolated
    // and its reload bound must survive here; this is the configuration where
    // the bound's old sessionStorage backing also throws, so this arm is the
    // regression test for both at once.
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true, get() { return undefined; },
        });
      } catch (_) {}
    });
  }

  // --- mobile device emulation ---
  // Sets viewport + DPR + hasTouch + mobile UA. The page's isMobile sniff
  // (dreamcast.html:1531) reads UA / 'ontouchstart' / innerWidth, so all three
  // of its triggers are exercised for real rather than short-circuited.
  let deviceDesc = null;
  if (MOBILE) {
    deviceDesc = puppeteer.KnownDevices[MOBILE_DEVICE];
    if (!deviceDesc) {
      console.error('[probe] unknown --device "' + MOBILE_DEVICE + '". Known names include: ' +
        Object.keys(puppeteer.KnownDevices).filter(k => /iPhone 1[34]|Pixel [57]|Galaxy S9/.test(k)).join(', '));
      process.exit(2);
    }
    await page.emulate(deviceDesc);
    console.log('[probe] MOBILE EMULATION: "' + MOBILE_DEVICE + '" ' +
      deviceDesc.viewport.width + 'x' + deviceDesc.viewport.height +
      ' dpr=' + deviceDesc.viewport.deviceScaleFactor +
      ' touch=' + deviceDesc.viewport.hasTouch + ' mobileUA=yes');
    console.log('[probe] NOT emulated: GPU driver, memory ceiling, thermal throttling.');
  }

  const linesAll = [];
  const milestones = new Set();
  // Renderer-health lines, kept verbatim and replayed in the summary: the
  // whole point of the mobile arm is that these are the fields that would
  // differ on a constrained profile.
  const glLines = [];
  const GL_RE = /\[glinfo\]|\[glcompat\]|INCOMPLETE framebuffer|CONTEXT LOST|context restored|returned NULL/;
  // Delivered-vblank samples (2026-08-28). EmscriptenWorker.cpp's once-per-
  // second heartbeat now emits a `[vbl]` line carrying the MONOTONIC counters
  // spg.cpp keeps (spg_vblank_frames / spg_vblank_in_ints) plus the live
  // Frame_Cycles. Parsed here so the summary can report a COUNTED vblank rate
  // — previously the port could only compute one from the SPG registers.
  const vblSamples = [];
  const VBL_RE = /^\[vbl\] /;
  function parseVbl(t) {
    const kv = {};
    for (const m of t.matchAll(/([a-z_]+)=([+-]?[0-9.]+)/g)) kv[m[1]] = parseFloat(m[2]);
    // required fields; a truncated line is dropped rather than half-counted
    if (kv.n === undefined || kv.t === undefined) return null;
    return kv;
  }
  let fatal = null;
  let lastSignalTime = Date.now();
  let workerReady = false;
  let stopReason = null;

  page.on('console', (msg) => {
    const t = msg.text();
    linesAll.push(t);
    if (isNoise(t)) return;
    process.stdout.write(t + '\n');
    lastSignalTime = Date.now();
    const c = classify(t);
    if (c === 'milestone') milestones.add(t.trim().slice(0, 120));
    if (c === 'fatal' && !fatal) fatal = t;
    if (GL_RE.test(t)) glLines.push(t.trim());
    if (VBL_RE.test(t)) { const s = parseVbl(t); if (s) { s.wall = Date.now(); vblSamples.push(s); } }
    if (/\[page\] worker ready/.test(t)) workerReady = true;
  });
  page.on('pageerror', (e) => {
    const t = '[pageerror] ' + (e && e.message ? e.message : String(e));
    linesAll.push(t);
    process.stdout.write(t + '\n');
    if (!fatal) fatal = t;
    lastSignalTime = Date.now();
  });

  const start = Date.now();
  const probeUrl = `http://127.0.0.1:${PORT}/dreamcast.html?diag=1`
    + (INTERP_ONLY ? '&interp=1' : '')
    + (NO_FASTMEM ? '&nofastmem=1' : '')
    + (NOIC ? '&noic=1' : '')
    + (SHARD_ON ? '&shard=1' : '')
    + (NOSHARD ? '&noshard=1' : '')
    + (NOARM7JIT ? '&noarm7jit=1' : '')
    + (ARM7SELFTEST ? '&arm7selftest=1' : '')
    + (PARITY ? `&parity=${PARITY}` : '')
    + (PARITY_MS ? `&parityms=${PARITY_MS}` : '')
    + (PARITY_FROM ? `&parityfrom=${PARITY_FROM}` : '')
    + (SAVESTATE_PATH && SAVE_MS ? `&autosave=${SAVE_MS}` : '')
    + (LOADSTATE_PATH ? '&autoload=1' : '')
    + (NO_REGCACHE ? '&noregcache=1' : '')
    + (NO_IMMFAST ? '&noimmfast=1' : '')
    + (INTERP_RANGE ? '&interprange=' + INTERP_RANGE : '')
    + (PC_TRACE_UNTIL ? `&pctrace=${PC_TRACE_UNTIL}` : '')
    + (PEEK_SPEC ? `&peek=${encodeURIComponent(PEEK_SPEC)}` : '')
    + (PEEK_MS ? `&peekms=${PEEK_MS}` : '')
    + (CTXSNAP ? '&ctxsnap=1' : '')
    + (NOCHAIN ? '&nochain=1' : '')
    + (IDLESKIP ? '&idleskip=1' : '')
    + (UNCAP ? '&uncap=1' : '')
    + (RTEINTC ? '&rteintc=1' : '')
    + (CTX_MS ? `&ctxms=${CTX_MS}` : '')
    + (MOBILE_FORCE ? '&mobile=1' : '')
    + (EXTRA_QUERY ? '&' + EXTRA_QUERY : '');
  await page.goto(probeUrl, { waitUntil: 'domcontentloaded' });

  // --- settle the isolation handshake ---------------------------------------
  // Without COOP/COEP headers the page's FIRST load is not isolated: the COI
  // service worker installs and the page reloads itself into isolation
  // (location.replace, so no history is stacked). Everything below — the shell
  // read, the Start tap — must happen on the settled load, not on the one that
  // is about to be replaced. Bounded, and the outcome is REPORTED either way:
  // "never became isolated" is a result, not an error to hide.
  let coiSettled = { isolated: false, tries: 0, fatal: false, ms: 0 };
  {
    const t0 = Date.now();
    const budget = 20000;
    for (;;) {
      let s = null;
      try {
        s = await page.evaluate(() => ({
          isolated: !!self.crossOriginIsolated,
          // ISOLATED IS NOT ENOUGH. crossOriginIsolated is true on the reloaded
          // document from its first byte, while the page script has not yet
          // run — and the mobile-shell block is the LAST thing in that script.
          // Breaking on isolation alone read the shell mid-load and reported
          // "*** MOBILE SHELL DID NOT ACTIVATE ***" on a page whose shell was
          // up 250 ms later. Measured 2026-09-01; a false negative here is
          // worse than no check, because this is the detector for "the phone
          // got the desktop layout".
          ready: document.readyState === 'complete',
          fatal: !!(document.getElementById('fatal') &&
                    getComputedStyle(document.getElementById('fatal')).display !== 'none'),
          sw: !!(navigator.serviceWorker),
          coitry: new URLSearchParams(location.search).get('coitry') || '0',
        }));
      } catch (_) { /* mid-navigation; try again */ }
      if (s) {
        // Count the page's OWN reload lines, not ?coitry= — the page strips that
        // param via history.replaceState the moment isolation succeeds, so
        // reading it back reported "0 reloads" for a run that visibly did one.
        const coiReloads = linesAll.filter((l) => /\[coi\] not cross-origin isolated — reload /.test(l)).length;
        coiSettled = { isolated: s.isolated, ready: s.ready, tries: coiReloads,
                       fatal: s.fatal, sw: s.sw, ms: Date.now() - t0 };
        if ((s.isolated && s.ready) || s.fatal) break;
      }
      if (Date.now() - t0 > budget) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log('[probe] isolation: crossOriginIsolated=' + coiSettled.isolated +
      ' (document ' + (coiSettled.ready ? 'complete' : 'STILL LOADING') + ')' +
      ' after ' + coiSettled.tries + ' COI reload(s) in ' + coiSettled.ms + 'ms' +
      (coiSettled.fatal ? ' — page raised its hard-stop panel' : '') +
      ' (navigator.serviceWorker ' + (coiSettled.sw ? 'present' : 'ABSENT') + ')');
  }

  // --- mobile shell state ---
  // Read the shell's own DOM rather than inferring it. `shellActive` is the
  // claim that matters: if this is false the "mobile" run silently measured
  // the desktop path and every other number is about the wrong code.
  async function shellState() {
    return page.evaluate(() => {
      const g = (id) => document.getElementById(id);
      // REAL visibility, not the element's own display rule. The old test
      // reported all 8 touch buttons as visible while their #mobileShell parent
      // was display:none — an inherited hide does not change a child's own
      // computed display. getClientRects() is empty for anything not laid out,
      // parents included, which is the question actually being asked.
      const vis = (el) => !!el && el.getClientRects().length > 0;
      const c = g('dc-canvas');
      const r = c ? c.getBoundingClientRect() : null;
      return {
        ua: navigator.userAgent,
        touchPoints: navigator.maxTouchPoints,
        ontouchstart: ('ontouchstart' in window),
        innerW: window.innerWidth, innerH: window.innerHeight, dpr: devicePixelRatio,
        crossOriginIsolated: !!self.crossOriginIsolated,
        shellActive: vis(g('mobileShell')),
        wrapHidden: !vis(g('wrap')),
        splashVisible: vis(g('mobileSplash')),
        logPanelShown: vis(g('mobileLog')),
        canvasParent: c && c.parentElement ? c.parentElement.id : null,
        canvasRect: r ? { w: Math.round(r.width), h: Math.round(r.height),
                          x: Math.round(r.x), y: Math.round(r.y) } : null,
        canvasAttr: c ? (c.width + 'x' + c.height) : null,
        status: (g('mobileStatus') || {}).textContent || '',
        touchBtns: ['mobileA','mobileB','mobileX','mobileY','mobileL','mobileR',
                    'mobileStart','mobileDpadDisc'].filter((id) => vis(g(id))).length,
      };
    });
  }
  const preStart = await shellState();
  console.log('[probe] shell pre-start: active=' + preStart.shellActive +
    ' wrapHidden=' + preStart.wrapHidden + ' splash=' + preStart.splashVisible +
    ' touchBtns=' + preStart.touchBtns + ' coi=' + preStart.crossOriginIsolated +
    ' vp=' + preStart.innerW + 'x' + preStart.innerH + '@' + preStart.dpr);
  if (MOBILE && !preStart.shellActive) {
    console.log('[probe] *** MOBILE SHELL DID NOT ACTIVATE *** — the page took the desktop ' +
      'branch under mobile emulation. isMobile sniff is at dreamcast.html:1531.');
  }

  // Tap the mobile splash Start. It is bound to `pointerdown` with
  // preventDefault() (dreamcast.html:1564), which suppresses the synthetic
  // click that a DOM .click() would rely on — so drive a REAL touch sequence
  // (CDP Input.dispatchTouchEvent), which Chrome turns into a genuine
  // pointerdown(pointerType="touch"). Each fallback tier is reported, because
  // "which tier worked" is itself the finding.
  async function tapMobileStart() {
    const box = await page.evaluate(() => {
      const b = document.getElementById('mobileSplashStart');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    });
    if (!box) return { ok: false, how: 'no #mobileSplashStart in DOM' };
    if (box.w === 0 || box.h === 0) return { ok: false, how: 'button has zero size (not laid out)' };
    const gone = async () => !(await page.evaluate(() =>
      getComputedStyle(document.getElementById('mobileSplash')).display !== 'none'));
    // Tier 1: real touch tap.
    try {
      await page.touchscreen.tap(box.x, box.y);
      await new Promise(r => setTimeout(r, 300));
      if (await gone()) return { ok: true, how: 'touchscreen.tap (real touch -> pointerdown)' };
    } catch (e) { process.stdout.write('[probe] touch tap threw: ' + e.message + '\n'); }
    // Tier 2: mouse press (Chrome also synthesises pointerdown from this).
    try {
      await page.mouse.click(box.x, box.y);
      await new Promise(r => setTimeout(r, 300));
      if (await gone()) return { ok: true, how: 'mouse.click (pointerdown via mouse)' };
    } catch (e) { process.stdout.write('[probe] mouse click threw: ' + e.message + '\n'); }
    // Tier 3: synthetic PointerEvent. Proves the handler works but that the
    // real input path did not reach it — a genuine mobile-input bug.
    const t3 = await page.evaluate(() => {
      const b = document.getElementById('mobileSplashStart');
      const Ev = window.PointerEvent || MouseEvent;
      b.dispatchEvent(new Ev('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' }));
      return getComputedStyle(document.getElementById('mobileSplash')).display === 'none';
    });
    if (t3) return { ok: true, how: 'SYNTHETIC pointerdown — REAL touch/mouse input did NOT reach the handler' };
    // Tier 4: bare DOM .click(). If only this works the handler is on click,
    // not pointerdown, and the comment in the page is wrong.
    const t4 = await page.evaluate(() => {
      document.getElementById('mobileSplashStart').click();
      return getComputedStyle(document.getElementById('mobileSplash')).display === 'none';
    });
    return t4 ? { ok: true, how: 'DOM .click() only' } : { ok: false, how: 'all four tiers failed' };
  }

  // Lever-5: CPU-profile the emulation worker via CDP (ground-truth wall
  // attribution across the static module, runtime-JIT'd block modules, and JS).
  let profStarted = false;
  async function maybeProfile() {
    if (!PROF_AT || profStarted || Date.now() - start < PROF_AT) return;
    profStarted = true;
    try {
      const workers = page.workers();
      // The emu worker is the flycast shim (largest/first non-pthread one).
      let target = null;
      for (const w of workers) {
        if (w.url().includes('flycast_worker.js')) { target = w; break; }
      }
      if (!target && workers.length) target = workers[0];
      if (!target) { process.stdout.write('[prof] no worker target\n'); return; }
      const cdp = (typeof target.client === 'function') ? await target.client() : target.client;
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      process.stdout.write('[prof] started on ' + target.url() + '\n');
      setTimeout(async () => {
        try {
          const { profile } = await cdp.send('Profiler.stop');
          require('fs').writeFileSync('/tmp/dcx-worker.cpuprofile', JSON.stringify(profile));
          process.stdout.write('[prof] wrote /tmp/dcx-worker.cpuprofile (' +
            profile.nodes.length + ' nodes)\n');
        } catch (e) { process.stdout.write('[prof] stop failed: ' + e.message + '\n'); }
      }, PROF_DUR);
    } catch (e) {
      process.stdout.write('[prof] failed: ' + e.message + '\n');
    }
  }

  // Shot series. Two images per point: the CANVAS alone (is the emulator
  // presenting?) and the whole SHELL (are the touch controls / splash / log
  // panel where they should be?). Both are measured, so the colour claim in
  // the bug report is answered with numbers.
  const shots = [];
  let startHow = null;
  let rotated = false, rotateResult = null;
  async function shoot(tag) {
    const dir = SHOTDIR || (SCREENSHOT_PATH ? path.dirname(SCREENSHOT_PATH) : '');
    if (!dir) return;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const base = SHOTDIR ? 'dc' : path.basename(SCREENSHOT_PATH, '.png');
    const targets = CANVAS_ONLY ? [['canvas', '#dc-canvas']]
                                : [['canvas', '#dc-canvas'], ['shell', null]];
    for (const [what, sel] of targets) {
      // Back-compat: plain `--screenshot X.png` (no --shotdir) must still write
      // the canvas to exactly X.png — other sessions' scripts read that path.
      // The shell companion and the mid-run series get the decorated names.
      const p = (!SHOTDIR && SCREENSHOT_PATH && tag === 'final' && what === 'canvas')
        ? SCREENSHOT_PATH
        : path.join(dir, `${base}-${tag}-${what}.png`);
      try {
        const el = sel ? await page.$(sel) : null;
        const buf = el ? await el.screenshot({ path: p }) : await page.screenshot({ path: p });
        let line = `[probe] shot -> ${p}`;
        try {
          const a = analyzePng(Buffer.from(buf));
          shots.push({ tag, what, path: p, a });
          line += '\n' + fmtShot(`${tag}/${what}`, a);
        } catch (e) { line += ' (analysis failed: ' + e.message + ')'; }
        process.stdout.write(line + '\n');
      } catch (e) { process.stdout.write(`[probe] shot ${tag}/${what} failed: ${e.message}\n`); }
    }
  }

  // Poll loop: auto-click Start when worker-ready, exit on idle/fatal/duration.
  let clicked = !AUTO_START;
  let midShots = MID_SHOTS_MS.slice();   // lever-4: timed mid-run screenshots
  let lastStrip = -1e9;                  // --shotevery: elapsed ms of the last strip frame
  let presses = PRESSES.slice().sort((a, b) => a.at - b.at);  // --press ms:Key:holdMs
  // --- liveness samples -----------------------------------------------------
  // window.__dcProbe() is the page's own monotonic progress counter. Sampling it
  // is the ONLY instrument here that separates "still downloading a 1.13 GB
  // disc" from "wedged": both paint a black canvas, so the pixel analysis above
  // answers neither. A flat `seq` across consecutive samples is the finding.
  const progSamples = [];
  let lastProgAt = 0;
  let progUnavailable = null;
  async function sampleProgress() {
    if (Date.now() - lastProgAt < PROG_MS) return;
    lastProgAt = Date.now();
    try {
      const p = await page.evaluate(() => (typeof window.__dcProbe === 'function' ? window.__dcProbe() : null));
      if (!p) {
        if (progUnavailable === null) {
          progUnavailable = 'window.__dcProbe is not defined — either this page predates the ' +
            'progress counter or its script died before defining it';
          process.stdout.write('[live] ' + progUnavailable + '\n');
        }
        return;
      }
      p.wall = Date.now() - start;
      progSamples.push(p);
      const prev = progSamples.length > 1 ? progSamples[progSamples.length - 2] : null;
      const dseq = prev ? p.seq - prev.seq : p.seq;
      process.stdout.write('[live] +' + (p.wall / 1000).toFixed(1) + 's ' + p.live.toUpperCase() +
        ' phase=' + p.phase + ' seq=' + p.seq + ' (+' + dseq + ')' +
        (p.discTotal ? ' disc=' + (p.discBytes / 1048576).toFixed(0) + '/' +
                       (p.discTotal / 1048576).toFixed(0) + 'MB' : '') +
        ' fields=' + p.fields + ' fps=' + p.fps +
        ' idle=' + (p.idleMs / 1000).toFixed(1) + 's\n');
    } catch (_) { /* navigation or a closed page: not a liveness fact */ }
  }

  while (Date.now() - start < DURATION_MS) {
    await new Promise(r => setTimeout(r, 250));
    if (fatal) { stopReason = 'fatal'; break; }
    await sampleProgress();
    await maybeProfile();
    while (presses.length && Date.now() - start >= presses[0].at) {
      const pr = presses.shift();
      (async () => {
        try {
          await page.keyboard.down(pr.key);
          process.stdout.write(`[probe] key down ${pr.key} (hold ${pr.hold}ms)\n`);
          await new Promise(r => setTimeout(r, pr.hold));
          await page.keyboard.up(pr.key);
          process.stdout.write(`[probe] key up ${pr.key}\n`);
        } catch (e) { process.stdout.write('[probe] press failed: ' + e.message + '\n'); }
      })();
    }
    if (ROTATE_MS && !rotated && Date.now() - start >= ROTATE_MS) {
      rotated = true;
      const vp = deviceDesc.viewport;
      const before = await page.evaluate(() => ({
        w: innerWidth, h: innerHeight,
        hint: getComputedStyle(document.getElementById('rotateHint')).display,
      }));
      await page.setViewport({ ...vp, width: vp.height, height: vp.width });
      await new Promise(r => setTimeout(r, 1500));
      const after = await page.evaluate(() => ({
        w: innerWidth, h: innerHeight,
        hint: getComputedStyle(document.getElementById('rotateHint')).display,
      }));
      rotateResult = { before, after };
      process.stdout.write(`[probe] ROTATE ${before.w}x${before.h} -> ${after.w}x${after.h}; ` +
        `#rotateHint ${before.hint} -> ${after.hint}\n`);
      await shoot('postrotate');
    }
    if (midShots.length && Date.now() - start >= midShots[0] && (SCREENSHOT_PATH || SHOTDIR)) {
      const t = midShots.shift();
      await shoot(`t${Math.round(t / 1000)}s`);
    }
    // Checkpoints: click the page's Save State, then image the same instant.
    while (SAVE_ATS.length && Date.now() - start >= SAVE_ATS[0]) {
      const at = SAVE_ATS.shift();
      try {
        await page.click('#btnSave');
        process.stdout.write(`[probe] checkpoint click at t=${at}ms\n`);
      } catch (e) { process.stdout.write('[probe] checkpoint click failed: ' + e.message + '\n'); }
      await shoot('ck' + String(Math.round(at / 1000)).padStart(3, '0'));
    }
    // Periodic filmstrip. Tagged by elapsed seconds so `ls` sorts into the
    // order the frames happened in, which is the whole point of a strip.
    if (SHOT_EVERY && (SCREENSHOT_PATH || SHOTDIR)) {
      const el = Date.now() - start;
      if (el >= SHOT_FROM && el - lastStrip >= SHOT_EVERY) {
        lastStrip = el;
        await shoot('s' + String(Math.round(el / 1000)).padStart(3, '0'));
      }
    }
    if (!clicked && workerReady) {
      if (MOBILE) {
        const r = await tapMobileStart();
        process.stdout.write('[probe] mobile Start: ' + (r.ok ? 'OK via ' : 'FAILED — ') + r.how + '\n');
        startHow = r.how; clicked = r.ok;
        if (!r.ok) { fatal = fatal || '[probe] mobile Start never fired: ' + r.how; }
        lastSignalTime = Date.now();
      } else {
        try {
          await page.click('#btnStart');
          process.stdout.write('[probe] clicked Start\n');
          clicked = true;
          lastSignalTime = Date.now();
        } catch (e) {
          process.stdout.write('[probe] Start click failed: ' + e.message + '\n');
        }
      }
    }
    if (Date.now() - lastSignalTime > IDLE_MS) {
      stopReason = 'idle (' + IDLE_MS + 'ms no new signal)';
      break;
    }
  }
  if (!stopReason) stopReason = 'duration-elapsed';

  // Capture the visible canvas (browser composites the worker's OffscreenCanvas
  // into it). Black PNG = HW frame not presented; non-black = presentation works.
  if (SCREENSHOT_PATH || SHOTDIR) await shoot('final');
  const postState = await shellState().catch(() => null);

  // Last liveness sample before teardown — the verdict below is about the state
  // the run ENDED in, so it must not be one poll interval stale.
  lastProgAt = 0;
  await sampleProgress();

  await browser.close();
  srv.close();
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}

  // --- summary ---
  console.log('');
  console.log('=== flycast probe summary ===');
  console.log('  stop:           ' + stopReason);
  console.log('  total_lines:    ' + linesAll.length);
  console.log('  worker_ready:   ' + (workerReady ? 'yes' : 'no'));
  console.log('  clicked_start:  ' + (clicked ? 'yes' : 'no'));
  console.log('  milestones:     ' + (milestones.size || 'none'));
  for (const m of milestones) console.log('    + ' + m);
  if (fatal) {
    console.log('  fatal:          ' + fatal.replace(/\n.*/s, ''));
  }

  // --- BOOTING vs BROKEN -----------------------------------------------------
  // The question a black canvas cannot answer. Read straight off the page's own
  // monotonic counter, sampled over the run.
  console.log('');
  console.log('  --- liveness (booting vs broken) ---');
  console.log('    isolation:     crossOriginIsolated=' + coiSettled.isolated +
              ' after ' + coiSettled.tries + ' COI reload(s)' +
              (NO_COI_HEADERS ? '  [server sent NO COOP/COEP — the service worker did this]'
                              : '  [server sent COOP/COEP — the service worker was NOT exercised]') +
              (NO_SW ? '  [navigator.serviceWorker hidden]' : ''));
  if (!progSamples.length) {
    console.log('    NO SAMPLES — ' + (progUnavailable ||
      'window.__dcProbe() never returned; the page script may have died before defining it'));
  } else {
    const first = progSamples[0], last = progSamples[progSamples.length - 1];
    // Longest run of consecutive samples with an unchanged seq. This is the
    // measurement: a healthy slow boot advances every sample, a wedge does not
    // advance at all, and the two are identical in a screenshot.
    let flat = 0, flatMax = 0, flatAt = 0;
    for (let i = 1; i < progSamples.length; i++) {
      if (progSamples[i].seq === progSamples[i - 1].seq) {
        flat++;
        if (flat > flatMax) { flatMax = flat; flatAt = progSamples[i].wall; }
      } else flat = 0;
    }
    const flatMs = flatMax * PROG_MS;
    console.log('    samples:       ' + progSamples.length + ' every ~' + PROG_MS + 'ms');
    console.log('    seq:           ' + first.seq + ' -> ' + last.seq +
                ' (+' + (last.seq - first.seq) + ')');
    console.log('    longest flat:  ' + flatMax + ' consecutive samples (~' + flatMs + 'ms)' +
                (flatMax ? ' ending at +' + (flatAt / 1000).toFixed(1) + 's' : ''));
    if (last.discTotal)
      console.log('    disc:          ' + (last.discBytes / 1048576).toFixed(0) + '/' +
                  (last.discTotal / 1048576).toFixed(0) + ' MB (' +
                  ((last.discBytes / last.discTotal) * 100).toFixed(1) + '%)');
    console.log('    final phase:   ' + last.phase + '  booted=' + last.booted +
                '  fields=' + last.fields + '  fps=' + last.fps +
                '  guest=' + (last.guestX || 0).toFixed(3) + 'x');
    console.log('    caps:          coi=' + last.coi + ' sab=' + last.sab +
                ' offscreen=' + last.offscreen + ' webgl2=' + last.webgl2 +
                ' stencil=' + (last.stencil && last.stencil.known
                                ? (last.stencil.on ? 'granted' : 'REFUSED') : 'unknown'));
    console.log('    heap:          init=' + last.heap.init + 'MB max=' + last.heap.max +
                'MB reduced=' + last.heap.reduced + (last.heap.err ? ' err=' + last.heap.err : ''));
    const verdict =
      last.live === 'running' ? 'RUNNING — frames are flowing'
      : last.live === 'stopped' ? 'BROKEN — ' + last.why
      : (last.seq > first.seq) ? 'BOOTING — the counter is still advancing, nothing has failed'
      : 'BROKEN — the counter never advanced across ' + progSamples.length + ' samples';
    console.log('    => ' + verdict);
    console.log('    page headline: ' + last.headline);
  }

  // --- renderer health ---
  console.log('');
  console.log('  --- renderer health (' + glLines.length + ' lines) ---');
  if (!glLines.length) console.log('    (none — no [glinfo]/[glcompat]/framebuffer line was emitted at all)');
  for (const l of glLines) console.log('    ' + l);
  const incomplete = glLines.filter(l => /INCOMPLETE framebuffer/.test(l)).length;
  const ctxLost    = glLines.filter(l => /CONTEXT LOST/.test(l)).length;
  const compat     = glLines.filter(l => /\[glcompat\]/.test(l)).length;
  const stencil    = (glLines.find(l => /granted attrs/.test(l)) || '').match(/stencil=(\w+)/);
  console.log('    => stencil=' + (stencil ? stencil[1] : 'UNKNOWN') +
              '  incompleteFBO=' + incomplete + '  contextLost=' + ctxLost + '  glcompat=' + compat);

  // --- mobile arm ---
  if (MOBILE) {
    console.log('');
    console.log('  --- mobile arm ---');
    console.log('    device:        ' + MOBILE_DEVICE + ' (' + deviceDesc.viewport.width + 'x' +
      deviceDesc.viewport.height + ' dpr=' + deviceDesc.viewport.deviceScaleFactor + ')');
    console.log('    shell active:  ' + preStart.shellActive + '  (wrapHidden=' + preStart.wrapHidden +
      ' touchBtns=' + preStart.touchBtns + '/8)');
    console.log('    coi:           ' + preStart.crossOriginIsolated);
    console.log('    start path:    ' + (startHow || 'not attempted'));
    if (postState) {
      console.log('    canvas:        parent=' + postState.canvasParent + ' attr=' + postState.canvasAttr +
        ' css=' + (postState.canvasRect ? postState.canvasRect.w + 'x' + postState.canvasRect.h : 'n/a'));
      console.log('    splash gone:   ' + (!postState.splashVisible) +
        '   log panel forced open: ' + postState.logPanelShown);
      console.log('    status line:   ' + JSON.stringify(postState.status));
    }
    if (rotateResult) {
      const r = rotateResult;
      console.log('    rotate test:   ' + r.before.w + 'x' + r.before.h + ' -> ' +
        r.after.w + 'x' + r.after.h + ';  #rotateHint ' + r.before.hint + ' -> ' + r.after.hint);
      const landscapeAfter = r.after.w > r.after.h;
      if (landscapeAfter && r.after.hint !== 'none')
        console.log('    *** ROTATE BUG: landscape reached but the full-screen overlay is STILL UP ***');
    }
  }
  if (shots.length) {
    console.log('');
    console.log('  --- screenshots ---');
    for (const s of shots) console.log('    ' + fmtShot(s.tag + '/' + s.what, s.a) + '  ' + s.path);
  }
  if (MOBILE) {
    console.log('');
    console.log('  NOTE: this is puppeteer DEVICE EMULATION — viewport, DPR, touch, UA.');
    console.log('        It does NOT reproduce a phone GPU driver, a phone memory ceiling,');
    console.log('        or thermal throttling. A pass here is NOT "works on a phone".');
  }

  // --- delivered vblanks (COUNTED, not derived) ---------------------------
  // Every number here is a difference of two MONOTONIC counter readings over a
  // difference of two readings of the worker's own performance.now() (field
  // `t`) — never console-arrival wall time, which jitters by milliseconds, and
  // never an average of the per-window averages.
  //
  // Two windows are reported and they are NOT interchangeable:
  //   FULL    — first to last sample. Includes the boot ramp, where the guest
  //             runs at ~0.5x for the first second and video_cb is almost all
  //             dupes. Reported because hiding it would be hiding data.
  //   SETTLED — from the first sample at least --vblsettle ms after the first
  //             sample, to the last. THIS is the number to compare against the
  //             register-derived rate; the FULL window answers a different
  //             question (what did the whole run average, boot included).
  console.log('');
  console.log('  --- delivered vblanks (counted) ---');
  if (vblSamples.length < 2) {
    console.log('    samples: ' + vblSamples.length + ' — need >= 2; no [vbl] heartbeat pair captured.');
    console.log('    (the counter lives in spg.cpp / EmscriptenWorker.cpp video_cb; if the run');
    console.log('     never reached a rendered frame, video_cb never fires and no sample exists)');
  } else {
    const z = vblSamples[vblSamples.length - 1];
    // Prediction straight off the live SPG programming carried in the sample:
    // Frame_Cycles = (vcount+1) * SH4_MAIN_CLOCK*(hcount+1)/pixel_clock [/2 if
    // interlaced], so predicted fields/s at exactly 200 MHz = 200e6/Frame_Cycles.
    const pred = z.fcyc ? 200e6 / z.fcyc : 0;
    const fcycVaried = new Set(vblSamples.map(s => s.fcyc)).size > 1;

    function report(label, a, b) {
      const dt   = (b.t - a.t) / 1000;                 // s, worker clock
      const dn   = b.n - a.n;                          // fields counted
      const dvbi = b.vbi - a.vbi;                      // vblank-IN interrupts
      const rate = dt > 0 ? dn / dt : 0;
      const rvbi = dt > 0 ? dvbi / dt : 0;
      // Guest ratio over this SAME window, from the same monotonic cycle
      // counter the rate is measured against. `cyc` is sh4_sched_now64().
      const guest = (dt > 0 && a.cyc !== undefined && b.cyc !== undefined)
        ? ((b.cyc - a.cyc) / 200e6) / dt : NaN;
      const expect = pred * guest;
      const dpct    = expect > 0 ? (rate / expect - 1) * 100 : NaN;
      const dpctRaw = pred > 0   ? (rate / pred   - 1) * 100 : NaN;
      const sgn = (v) => (isNaN(v) ? '?' : (v >= 0 ? '+' : '') + v.toFixed(4) + '%');
      console.log('    [' + label + '] window ' + dt.toFixed(3) + ' s (worker clock)');
      console.log('      counted:            ' + dn + ' fields = ' + rate.toFixed(4) + '/s');
      console.log('      vblank-IN ints:     ' + dvbi + ' = ' + rvbi.toFixed(4) + '/s  ' +
                  (dn === dvbi ? '[identical to field count]'
                               : '[DIFFERS from field count by ' + (dvbi - dn) + ']'));
      console.log('      guest ratio:        ' + (isNaN(guest) ? '?' : guest.toFixed(5) + 'x') +
                  '  (sh4_sched_now64 over the same window)');
      console.log('      computed:           ' + pred.toFixed(4) + '/s at exactly 200 MHz' +
                  '   x guest = ' + (isNaN(expect) ? '?' : expect.toFixed(4) + '/s'));
      console.log('      COUNTED vs COMPUTED: ' + sgn(dpct) +
                  '   (vs unscaled 200 MHz figure: ' + sgn(dpctRaw) + ')');
      if (b.calls !== undefined && b.pres !== undefined) {
        const dc = b.calls - a.calls, dp = b.pres - a.pres;
        console.log('      video_cb:           ' + dc + ' calls, ' + dp + ' presents, ' + (dc - dp) +
                    ' dupes = ' + (dc ? ((dc - dp) / dc * 100).toFixed(4) : '0') + '%');
        console.log('      video_cb rate:      ' + (dt > 0 ? (dc / dt).toFixed(4) : '0') + ' calls/s, ' +
                    (dt > 0 ? (dp / dt).toFixed(4) : '0') + ' presents/s' +
                    '   (fields/present = ' + (dp ? (dn / dp).toFixed(4) : '?') + ')');
      }
    }

    const first = vblSamples[0];
    console.log('    samples:        ' + vblSamples.length +
                '   Frame_Cycles=' + z.fcyc + (fcycVaried ? ' (VARIED during the run)' : ' (constant)'));
    report('FULL', first, z);
    const settleAt = first.t + VBL_SETTLE_MS;
    const s0 = vblSamples.find(s => s.t >= settleAt);
    console.log('');
    if (s0 && s0 !== z) report('SETTLED +' + (VBL_SETTLE_MS / 1000) + 's', s0, z);
    else console.log('    [SETTLED] not enough run after +' + (VBL_SETTLE_MS / 1000) + 's to form a window');

    // Per-window guest ratios: a cumulative average would silently absorb a
    // step in sh4_sched_now64(); listing the outliers makes one visible.
    const wg = vblSamples.map(s => s.wguest).filter(v => v !== undefined && isFinite(v));
    if (wg.length) {
      const bad = vblSamples.filter(s => s.wguest !== undefined && (s.wguest > 2 || s.wguest < 0.4));
      const sorted = wg.slice().sort((x, y) => x - y);
      console.log('');
      console.log('    per-window guest ratio: min=' + sorted[0].toFixed(5) +
                  ' median=' + sorted[Math.floor(sorted.length / 2)].toFixed(5) +
                  ' max=' + sorted[sorted.length - 1].toFixed(5) +
                  '  (' + wg.length + ' windows)');
      if (bad.length) {
        console.log('    !! ' + bad.length + ' window(s) outside 0.4x..2x — sh4_sched_now64() is NOT');
        console.log('       continuous across them; any cumulative rate spanning one is invalid:');
        for (const s of bad.slice(0, 5))
          console.log('         t=' + s.t.toFixed(0) + ' wguest=' + s.wguest.toFixed(5) +
                      'x  cyc=' + s.cyc + '  win=' + s.win.toFixed(4) + '/s');
      }
    }
    console.log('    last raw sample: ' + (linesAll.filter(l => VBL_RE.test(l)).pop() || ''));
  }

  // Hash-guard, closing half: same digest as the opening line => the binary
  // did not change under the run. A mismatch invalidates every number above.
  const hashPost = hashArtifacts(ROOT);
  console.log('');
  console.log('  --- artifact hash-guard ---');
  let hashChanged = false;
  for (let i = 0; i < hashPost.length; i++) {
    const same = hashPre[i].sha256 === hashPost[i].sha256;
    if (!same) hashChanged = true;
    console.log('    ' + (same ? 'STABLE  ' : 'CHANGED ') + hashPost[i].rel +
                ' sha256=' + hashPost[i].sha256.slice(0, 16) + ' size=' + hashPost[i].size);
  }
  if (hashChanged)
    console.log('    !! the served artifact changed DURING the run — results above are not attributable');

  if (LOG_PATH) {
    fs.writeFileSync(LOG_PATH, linesAll.join('\n') + '\n');
    console.log('  full_log:       ' + LOG_PATH + ' (' + linesAll.length + ' lines, includes noise)');
  }

  process.exit(fatal ? 1 : 0);
})();
