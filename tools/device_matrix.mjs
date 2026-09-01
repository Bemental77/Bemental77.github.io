// tools/device_matrix.mjs — the standing device-portability gate for the three
// emulator pages (gamecube.html, dreamcast.html, n64/index.html).
//
//   npm run web                       # serve on :8080 first (CLAUDE.md gate #2)
//   node tools/device_matrix.mjs
//   node tools/device_matrix.mjs --arm=no-webgpu --page=gamecube
//   node tools/device_matrix.mjs --json > /tmp/matrix.json
//
// ============================================================================
// TWO HARNESS BUGS THIS RIG IS BUILT TO DESIGN OUT
// ============================================================================
// Both already produced worthless results on this project, and both produced
// results that LOOKED CLEAN, which is what makes them expensive.
//
// BUG 1 — CAPABILITY CHECKS THAT TEST PRESENCE, NOT FUNCTION.
//   Reading `!!navigator.gpu` returned gpu=true under a flag that disables
//   WebGPU. Measured on this machine 2026-09-01, Chrome 140, on gamecube.html:
//
//       flag                                    navigator.gpu   requestAdapter()
//       (none)                                  true            adapter
//       --disable-gpu                           TRUE            null
//       --disable-features=WebGPUService,Dawn   TRUE            null
//       --disable-features=WebGPU               true            adapter   (NO-OP!)
//       --disable-blink-features=WebGPU         true            adapter   (NO-OP!)
//
//   Two lessons in one table. The property is truthy on a machine with no
//   adapter, AND two of the four "disable WebGPU" spellings do nothing at all —
//   so an arm can be a placebo while its name says otherwise. This rig therefore
//   (a) reads only the FUNCTIONAL fields of window.__cap (lib/capability.js,
//   which does requestAdapter->requestDevice->getContext->configure), and
//   (b) requires every arm to PROVE it changed something (see BUG 3).
//
// BUG 2 — CROSS-ORIGIN ISOLATION IS ORIGIN-SCOPED AND PERSISTS.
//   coi-serviceworker.js installs COOP/COEP for the whole origin. Visiting
//   gamecube.html first therefore silently isolates every page visited after it
//   in the same browser profile — including n64/, whose entire design point is
//   that it needs no isolation. A prior matrix run returned TWELVE IDENTICAL
//   ROWS because of this. Every arm here gets its own fresh `userDataDir`, which
//   is deleted afterwards, and the rig proves the isolation works rather than
//   assuming it (see `rigSelfTest` — it deliberately reproduces the leak in one
//   profile and requires a fresh profile not to show it).
//
// BUG 3 — THE FALSE NULL. This project has produced three "clean" results that
//   measured nothing: an A/B where a loader cache made both arms run identical
//   code, a campaign comparing two identical configs because the path under test
//   was dead code, and a spread blamed on machine load that was a concurrent
//   writer on the rig's own output file. All three looked like passes.
//   So: EVERY ARM CARRIES AN ARM-DIFFERENCE PROOF — a named value that must
//   demonstrably differ from the baseline arm. If the proof does not hold, the
//   arm is VOID and prints NO VERDICT. A void arm is not a pass and not a
//   failure; it is a statement that the rig did not manage to create the
//   condition it claims to test, which is the only honest thing to say.
//
// ============================================================================
// WHAT THIS RIG CANNOT DO — stated, not papered over
// ============================================================================
// Chrome device emulation gets viewport, touch and user-agent right, but it RUNS
// CHROME'S ENGINE. It is not iOS Safari. The user's original failure was on a
// real iPhone, and iOS Safari differs from Chrome in exactly the areas that
// matter here: WebKit's WebGL/WebGPU implementation, its far tighter limits on
// large and shared WebAssembly.Memory (emscripten#19144, cited at
// dreamcast.html:1315), and its own service-worker and COEP behaviour. Any row
// tagged `enginesDiffer: true` is a Chrome result wearing an iPhone's clothes.
// It can prove a LAYOUT or INPUT bug and it can prove a page's own gating logic;
// it CANNOT clear the page on real iOS. That needs hardware.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.MATRIX_BASE || 'http://localhost:8080';
const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY_ARM = argOf('arm', null);
const ONLY_PAGE = argOf('page', null);
const JSON_ONLY = argv.includes('--json');

// The three pages, with the capability spec each one actually needs. The specs
// are the same shape lib/capability.js consumes and lib/capability.test.js
// asserts, so a page and the rig cannot drift apart on what "required" means.
const PAGES = [
  { id: 'gamecube', url: '/gamecube.html',
    spec: { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgpu: 'required' } },
  { id: 'dreamcast', url: '/dreamcast.html',
    spec: { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgl2: 'required' } },
  // THE PORTABILITY REFERENCE. N64Wasm is single-threaded: no SAB, no COI, no
  // WebGPU, no worker. If an arm breaks this page, the arm broke something
  // universal — which makes it the control for every other row.
  { id: 'n64', url: '/n64/', spec: { wasm: 'required', webgl2: 'required' } },
];

// ---------------------------------------------------------------------------
// The arms. `proof` is the arm-difference contract: given the BASELINE report
// and this arm's report, it must return {ok:true} or the arm is void.
// ---------------------------------------------------------------------------
const ARMS = [
  {
    id: 'desktop',
    what: 'Full desktop Chrome, nothing disabled. The reference every other arm is a delta from.',
    args: [],
    baseline: true,
    // The baseline proves itself by being healthy: if the reference machine
    // cannot do the things, no delta below means anything.
    proof: (_b, a) => {
      const w = a.cap?.webgpu, g = a.cap?.webgl2;
      return { ok: !!(w?.adapter && g?.ok),
               detail: `baseline must be healthy: webgpu.adapter=${w?.adapter} webgl2.ok=${g?.ok}` };
    },
  },
  {
    id: 'no-webgpu',
    what: 'WebGPU removed, GPU otherwise intact — the realistic "my browser has no WebGPU" device '
        + '(Firefox, older Safari, enterprise policy). This is the arm for the GameCube black screen.',
    // MEASURED: this is the only spelling tested that removes the adapter while
    // leaving WebGL2 on the real GPU. --disable-features=WebGPU is a no-op.
    args: ['--disable-features=WebGPUService,Dawn'],
    proof: (b, a) => {
      const changed = b.cap?.webgpu?.adapter === true && a.cap?.webgpu?.adapter === false;
      const glKept = a.cap?.webgl2?.ok === true;
      return { ok: changed && glKept,
               detail: `webgpu.adapter ${b.cap?.webgpu?.adapter}->${a.cap?.webgpu?.adapter} `
                     + `(must flip true->false); webgl2.ok=${a.cap?.webgl2?.ok} (must stay true, or this is `
                     + `the no-gpu arm wearing the wrong name)` };
    },
  },
  {
    id: 'no-gpu',
    what: 'No GPU at all: neither WebGPU nor WebGL2. The floor case — software everything.',
    args: ['--disable-gpu'],
    proof: (b, a) => {
      const wg = b.cap?.webgpu?.adapter === true && a.cap?.webgpu?.adapter === false;
      const gl = b.cap?.webgl2?.ok === true && a.cap?.webgl2?.ok === false;
      return { ok: wg && gl,
               detail: `webgpu.adapter ${b.cap?.webgpu?.adapter}->${a.cap?.webgpu?.adapter}, `
                     + `webgl2.ok ${b.cap?.webgl2?.ok}->${a.cap?.webgl2?.ok} (BOTH must flip true->false)` };
    },
  },
  {
    id: 'no-coi',
    what: 'Cross-origin isolation blocked: the coi-serviceworker request is aborted, so COOP/COEP never '
        + 'install and SharedArrayBuffer never appears. Models a proxy that strips headers, a browser '
        + 'with service workers off, or the very first visit before the reload.',
    args: [],
    // Aborting the request is a truer model than deleting the tag: the page's
    // own code still runs its "am I isolated?" path exactly as shipped.
    hook: async (page) => {
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        if (/coi-serviceworker\.js/.test(r.url())) r.abort().catch(() => {});
        else r.continue().catch(() => {});
      });
    },
    proof: (b, a) => {
      const coi = b.cap?.sab?.crossOriginIsolated === true && a.cap?.sab?.crossOriginIsolated === false;
      return { ok: coi,
               detail: `sab.crossOriginIsolated ${b.cap?.sab?.crossOriginIsolated}->`
                     + `${a.cap?.sab?.crossOriginIsolated} (must flip true->false). `
                     + `SAB constructor now: ${a.cap?.sab?.ctor}` };
    },
    // n64/ never loads coi-serviceworker at all, so on that page this arm cannot
    // flip anything — and correctly so. It is skipped there rather than voided,
    // because "no change" IS the invariant being asserted for n64.
    invariantFor: { n64: (a) => ({
      ok: a.cap?.sab?.crossOriginIsolated === false,
      detail: 'n64/ must be un-isolated with or without the service worker; it requires neither' }) },
  },
  {
    id: 'mobile-ios',
    what: 'iPhone viewport + touch + iOS user agent. Proves layout, touch targets and the page\'s own '
        + 'mobile branch. Runs CHROME\'S ENGINE — see the header: this cannot clear real iOS Safari.',
    args: [],
    enginesDiffer: true,
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    proof: (b, a) => {
      const touch = b.cap?.env?.touch === false && a.cap?.env?.touch === true;
      const ua = a.cap?.env?.iosUA === true && b.cap?.env?.iosUA === false;
      const vw = a.cap?.env?.vw !== b.cap?.env?.vw;
      return { ok: touch && ua && vw,
               detail: `touch ${b.cap?.env?.touch}->${a.cap?.env?.touch}, iosUA ${b.cap?.env?.iosUA}->`
                     + `${a.cap?.env?.iosUA}, viewport ${b.cap?.env?.vw}->${a.cap?.env?.vw} `
                     + `(all three must differ, or device emulation did not take)` };
    },
  },
  {
    id: 'low-memory',
    what: 'A constrained V8 heap. Also runs the 512 MB WebAssembly.Memory probe, which is the '
        + 'allocation the N64 core actually asks for at start.',
    args: ['--js-flags=--max-old-space-size=192'],
    probeHeap: true,
    proof: (b, a) => {
      const bl = b.cap?.env?.jsHeapLimitMB, al = a.cap?.env?.jsHeapLimitMB;
      return { ok: typeof bl === 'number' && typeof al === 'number' && bl !== al,
               detail: `env.jsHeapLimitMB ${bl}->${al} (must differ, or --js-flags did not take)` };
    },
  },
  {
    id: 'slow-net',
    what: 'Throttled network. The Dreamcast disc and the split ROM parts are fetched at runtime, so '
        + 'this is the arm where a page must not look broken while it is merely slow.',
    args: [],
    netThrottle: { offline: false, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024, latency: 400 },
    proof: (b, a) => {
      // The rig times a same-origin fetch from INSIDE the page, so it goes
      // through the throttled network stack. A ratio, not an absolute, because
      // absolutes on a loaded machine are noise (CLAUDE.md gate #10).
      const bm = b.fetchMs, am = a.fetchMs;
      const ratio = (typeof bm === 'number' && bm > 0 && typeof am === 'number') ? am / bm : null;
      return { ok: ratio !== null && ratio >= 3,
               detail: `in-page fetch of /lib/capability.js: ${bm?.toFixed?.(1)}ms -> ${am?.toFixed?.(1)}ms `
                     + `(ratio ${ratio === null ? '?' : ratio.toFixed(1)}x, must be >= 3x)` };
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// One (arm, page) cell.
// ---------------------------------------------------------------------------
async function runCell(arm, pg) {
  // FRESH PROFILE PER CELL. Not per arm — per cell. Cross-origin isolation is
  // installed by whichever page ran first, so even two pages inside one arm
  // would contaminate each other. This directory is removed in the finally.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dmx-${arm.id}-${pg.id}-`));
  const out = { arm: arm.id, page: pg.id, profile: dir, consoleErrors: [], pageErrors: [], failedRequests: [] };
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new', executablePath: CHROME, userDataDir: dir,
      args: ['--no-sandbox', '--disable-dev-shm-usage', ...(arm.args || [])],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 180)); });
    page.on('pageerror', (e) => out.pageErrors.push(String(e).slice(0, 180)));
    page.on('response', (r) => { if (r.status() >= 400) out.failedRequests.push(`${r.url().slice(-70)} HTTP${r.status()}`); });

    if (arm.viewport) await page.setViewport(arm.viewport);
    if (arm.ua) await page.setUserAgent(arm.ua);
    if (arm.hook) await arm.hook(page);

    // ---- NETWORK THROTTLING MUST REACH THE SERVICE WORKER TOO ---------------
    // Page-scoped CDP throttling does NOT cover a service worker: the worker is
    // a separate CDP target, and coi-serviceworker.js re-issues EVERY request
    // through its own `fetch()` (coi-serviceworker.js:2, the `respondWith`
    // handler). Measured on the first full run of this rig:
    //
    //     page          in-page fetch, desktop -> slow-net
    //     n64/          1.9 ms  ->  407.6 ms      (214x — no service worker)
    //     gamecube.html 2.4 ms  ->    2.8 ms      (1.2x — SW bypassed it)
    //     dreamcast.html 2.9 ms ->    3.1 ms      (1.1x — SW bypassed it)
    //
    // The navigation itself WAS throttled (navMs 166 -> 9414), which is what
    // makes this so easy to miss: the arm looks like it took. The rig only
    // caught it because the arm-difference proof measured the thing the arm
    // claims to change instead of trusting the flag. Every target gets the
    // conditions, and any that appear later (the SW registers asynchronously)
    // get them when they appear.
    const throttled = new Set();
    const applyThrottle = async () => {
      if (!arm.netThrottle) return;
      for (const t of browser.targets()) {
        const type = t.type();
        if (!['page', 'service_worker', 'worker', 'shared_worker'].includes(type)) continue;
        const key = t.url() + '|' + type;
        if (throttled.has(key)) continue;
        try {
          const s = await t.createCDPSession();
          await s.send('Network.enable');
          await s.send('Network.emulateNetworkConditions', arm.netThrottle);
          throttled.add(key);
        } catch (e) { /* not every target accepts the Network domain */ }
      }
    };
    await applyThrottle();

    // PROBE ON THE REAL PAGE. An earlier matrix probed about:blank and got
    // navigator.gpu=false in BOTH arms, proving nothing: about:blank has no
    // origin, no service worker, and no page-side probe to read.
    const t0 = Date.now();
    await page.goto(BASE + pg.url, { waitUntil: 'domcontentloaded' });
    out.navMs = Date.now() - t0;

    // window.__cap is published by lib/capability.js once its async probes
    // resolve. Waiting for the PROMISE, not polling for a truthy value, is what
    // keeps a half-filled report from being read as a finished one.
    const waitCap = () => page.waitForFunction('window.__cap && window.__cap.ver === 1', { timeout: 45000 })
      .then(() => true).catch(() => false);
    out.capReady = await waitCap();
    out.cap = await page.evaluate(() => (window.__cap ? JSON.parse(JSON.stringify(window.__cap)) : null));

    // ---- THE FIRST-VISIT RELOAD, settled rather than raced ------------------
    // coi-serviceworker.js does not merely register a worker; it RELOADS THE
    // PAGE ITSELF (`s.active && !navigator.serviceWorker.controller` ->
    // `doReload()`, coi-serviceworker.js:2). On a first visit to a fresh profile
    // — which is every cell in this rig — the document is therefore live but not
    // yet isolated for a moment, and then the context is destroyed underneath
    // whatever was reading it.
    //
    // Reading __cap inside that window reported `coi,sab` MISSING ON THE FULL
    // DESKTOP BASELINE: the rig manufacturing the exact failure it exists to
    // detect. A false positive of that shape is worse than no rig at all,
    // because it looks like a finding.
    //
    // So: wait for the page to SETTLE. Every evaluate is fault-tolerant, because
    // "Execution context was destroyed" is the expected midpoint here, not an
    // error. If the self-reload does not come, one explicit reload is issued —
    // which is exactly the "reload once" a real visitor is told to do. Whether a
    // reload was needed is RECORDED, because "no SharedArrayBuffer until you
    // reload" is a portability fact, not something to hide.
    //
    // This cannot mask a genuine failure: the no-coi arm aborts the worker
    // request, so nothing here can make it isolated, and it settles false.
    const peek = () => page.evaluate(() => ({
      cap: !!(window.__cap && window.__cap.ver === 1),
      coi: !!self.crossOriginIsolated,
      swReg: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    })).catch(() => null);
    out.coiNeededReload = false;
    out.coiSettled = false;
    // Only pages that actually REQUIRE isolation wait for it. n64/ never loads
    // coi-serviceworker (that is the whole point of the portability reference),
    // so its crossOriginIsolated is permanently and correctly false — an earlier
    // cut ran the full settle loop there anyway, burning ~12 s per cell and
    // then reporting `coiNeededReload: true` about a page that needs no coi at
    // all. A field that is wrong on the reference page poisons the reference.
    if (pg.spec.coi === 'required'
        && out.cap && out.cap.sab && out.cap.sab.crossOriginIsolated === false) {
      for (let i = 0; i < 24; i++) {                 // up to ~12 s of self-reload
        const s = await peek();
        if (s && s.cap && s.coi) { out.coiSettled = true; break; }
        if (i === 12 && !out.coiNeededReload) {      // it never came — do it ourselves
          out.coiNeededReload = true;
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        await sleep(500);
      }
      out.capReady = await waitCap();
      out.cap = await page.evaluate(() => (window.__cap ? JSON.parse(JSON.stringify(window.__cap)) : null))
        .catch(() => out.cap);
    } else if (out.cap) {
      out.coiSettled = true;                          // isolated on the first load, or does not need it
    }

    // The service worker registers asynchronously, so on a first visit it did
    // not exist when the conditions were first applied. Re-apply now that the
    // page has settled and it does.
    await applyThrottle();

    if (arm.probeHeap && out.cap) {
      out.heap512 = await page.evaluate(() => window.Capability.probeHeap(512)).catch(() => 'probe threw');
    }

    // In-page fetch timing: the arm-difference proof for slow-net, and a cheap
    // sanity number everywhere else.
    out.fetchMs = await page.evaluate(async () => {
      const t = performance.now();
      try { await fetch('/lib/capability.js?cb=' + Math.random(), { cache: 'no-store' }); }
      catch (e) { return null; }
      return performance.now() - t;
    }).catch(() => null);

    // ---- the page's own gating: is Start honest about this device? ----------
    out.start = await page.evaluate(() => {
      const pick = (id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const cs = getComputedStyle(e);
        const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && e.getBoundingClientRect().height > 0;
        return { present: true, visible: vis, disabled: !!e.disabled,
                 blockedBy: e.getAttribute('data-cap-blocked'), text: (e.textContent || '').trim().slice(0, 90) };
      };
      return { desktop: pick('btnStart'), mobile: pick('mobileSplashStart') };
    }).catch(() => null);

    // SPEC-DRIFT CROSS-CHECK. The rig keeps its own copy of each page's
    // requirement spec (it needs one before a browser exists), and the module
    // ships the authoritative one. Two copies of a config that are ASSUMED equal
    // is precisely how this project once ran a whole campaign comparing two
    // identical arms. So the rig compares them on every cell and fails loudly.
    out.specMatchesPage = await page.evaluate((id, mine) => {
      const theirs = window.Capability && window.Capability.SPECS && window.Capability.SPECS[id];
      if (!theirs) return 'page publishes no spec for ' + id;
      const a = JSON.stringify(Object.keys(mine).sort().map((k) => [k, mine[k]]));
      const b = JSON.stringify(Object.keys(theirs).sort().map((k) => [k, theirs[k]]));
      return a === b ? true : `rig=${a} page=${b}`;
    }, pg.id, pg.spec).catch((e) => 'evaluate failed: ' + String(e).slice(0, 80));

    // The page's own honest verdict, computed by the SHARED module against the
    // page's OWN spec. This is the line a visitor would read.
    out.verdict = await page.evaluate((spec) => {
      if (!window.Capability) return null;
      const v = window.Capability.verdict(spec);
      return { level: v.level, short: v.short,
               blockers: window.Capability.blockers(spec).map((b) => b.id) };
    }, pg.spec).catch(() => null);

    // Does the page still have a working diagnostic route on this device? The
    // report is the ONLY artefact a visitor on a broken device can send.
    out.report = await page.evaluate(() => {
      if (!window.Capability) return null;
      const t = window.Capability.text();
      return { len: t.length, hasHeader: t.indexOf('--- CAPABILITY') === 0,
               // The decisive line must be near the TOP. A rolling tail evicts
               // whatever prints earliest, and the capability line prints once.
               capLineIdx: t.indexOf('[cap] WebGPU'), noUndefined: t.indexOf('undefined') < 0 };
    }).catch(() => null);

    await page.close();
  } catch (e) {
    out.error = String(e).slice(0, 300);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RIG SELF-TEST. The rig's own load-bearing assumption is that a fresh
// userDataDir per cell prevents cross-origin isolation from leaking between
// cells. That assumption is what produced twelve identical rows when it was
// merely believed, so it is measured here: the leak is deliberately REPRODUCED
// in one profile, and a fresh profile is required not to show it.
//
// If `leakReproduced` is false, the rig cannot prove its own isolation works,
// and every no-coi row below is untrustworthy. It is reported either way.
// ---------------------------------------------------------------------------
async function rigSelfTest() {
  const t = {};
  const coiOf = async (page, url) => {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__cap && window.__cap.ver === 1', { timeout: 45000 }).catch(() => {});
    return page.evaluate(() => !!self.crossOriginIsolated);
  };
  // (a) FRESH profile, n64/ only. n64/index.html loads no coi-serviceworker, so
  //     this must be false. This is the reference.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-self-a-'));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const p = await b.newPage();
    t.freshN64Coi = await coiOf(p, '/n64/');
    await b.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // (b) SAME profile: gamecube.html first (which installs COOP/COEP for the
  //     whole origin), THEN n64/. If isolation leaks across pages — and it does
  //     — n64/ now reports true despite loading no service worker of its own.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-self-b-'));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const p = await b.newPage();
    t.gcCoi = await coiOf(p, '/gamecube.html');
    await sleep(600);
    t.n64AfterGcCoi = await coiOf(p, '/n64/');
    await b.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  t.leakReproduced = (t.freshN64Coi === false && t.n64AfterGcCoi === true);
  t.isolationHolds = (t.freshN64Coi === false);
  t.note = t.leakReproduced
    ? 'CONFIRMED: visiting gamecube.html isolates the origin for n64/ in the same profile. '
    + 'A shared-profile matrix would report identical rows. Per-cell fresh profiles are load-bearing.'
    : t.isolationHolds
      ? 'Isolation did not leak in this run, so the fresh-profile guarantee could not be demonstrated '
      + 'by contrast. Rows are still per-cell isolated, but this run does not PROVE the guarantee matters.'
      : 'A FRESH profile already reported n64/ as cross-origin-isolated. Profile isolation is NOT working '
      + 'and every row in this run is suspect.';
  return t;
}

// ---------------------------------------------------------------------------
// The root n64.html redirect. It is a meta-refresh plus a location.replace, and
// a meta-refresh is fragile, so both routes are tested separately AND the
// no-JavaScript case is tested on its own — that is the one the script cannot
// cover for.
// ---------------------------------------------------------------------------
async function redirectTest() {
  const t = { };
  const run = async (label, opts) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dmx-rd-${label}-`));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const p = await b.newPage();
    if (opts.noJs) await p.setJavaScriptEnabled(false);
    if (opts.slow) {
      const cdp = await p.target().createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions',
        { offline: false, downloadThroughput: 30 * 1024, uploadThroughput: 20 * 1024, latency: 800 });
    }
    const r = { };
    try {
      const resp = await p.goto(BASE + (opts.path || '/n64.html'), { waitUntil: 'domcontentloaded' });
      r.status = resp && resp.status();
      // The meta-refresh fires after load, so give it a beat; without JS this is
      // the ONLY mechanism, which is exactly why it gets its own arm.
      await sleep(opts.slow ? 4000 : 1500);
      r.landedOn = p.url();
      r.arrived = /\/n64\/(\?|$)/.test(p.url());
      // Arrived is not enough: the page it landed on must be the working one.
      r.pageWorks = opts.noJs ? null : await p.evaluate(() => !!document.getElementById('btnStart')).catch(() => false);
      // A visitor whose redirect does NOT fire must still be given a link. This
      // has to be read from n64.html's OWN SOURCE, not from the live DOM: by the
      // time the DOM is readable the redirect has usually already replaced the
      // document, so a DOM query reports "no link" on a page that has one. The
      // first cut did exactly that and printed link=false on all four rows.
      r.hasVisibleLink = /<a[^>]+href="\/n64\/"/.test(await (await fetch(BASE + '/n64.html')).text());
      // The query string must survive: /n64.html?game=x is a real inbound shape.
      if (opts.path && opts.path.indexOf('?') >= 0) r.queryKept = p.url().indexOf('game=mariokart.z64') >= 0;
    } catch (e) { r.error = String(e).slice(0, 200); }
    await b.close(); fs.rmSync(dir, { recursive: true, force: true });
    return r;
  };
  t.js = await run('js', {});
  t.noJs = await run('nojs', { noJs: true });
  t.slow = await run('slow', { slow: true });
  t.query = await run('query', { path: '/n64.html?game=mariokart.z64' });
  // With JS: location.replace does it. Without JS: the meta-refresh must, and if
  // it somehow does not, the visitor must at minimum see a working link — that
  // is the floor, and it is asserted separately so a meta-refresh regression
  // cannot hide behind the anchor.
  t.ok = !!(t.js.arrived && t.js.pageWorks && t.slow.arrived
            && (t.noJs.arrived || t.noJs.hasVisibleLink) && t.query.arrived && t.query.queryKept !== false);
  t.metaRefreshWorksWithoutJs = t.noJs.arrived === true;
  return t;
}

// ---------------------------------------------------------------------------
// Verdicts. A cell only gets one if its arm's proof held.
// ---------------------------------------------------------------------------
function judge(arm, pg, cell, baselineCell) {
  const v = { arm: arm.id, page: pg.id };
  if (cell.error) { v.verdict = 'ERROR'; v.why = cell.error; return v; }
  if (!cell.capReady) { v.verdict = 'ERROR'; v.why = 'window.__cap never resolved — lib/capability.js did not run'; return v; }
  if (cell.specMatchesPage !== true) {
    v.verdict = 'ERROR';
    v.why = 'SPEC DRIFT — the rig and the page disagree about what this page requires: ' + cell.specMatchesPage;
    return v;
  }

  // THE ARM-DIFFERENCE PROOF. No proof, no verdict.
  const inv = arm.invariantFor && arm.invariantFor[pg.id];
  const proof = inv ? inv(cell) : arm.proof(baselineCell || cell, cell);
  v.proof = proof.detail;
  v.proofHeld = proof.ok;
  if (!proof.ok) {
    v.verdict = null;
    v.void = 'ARM DID NOT TAKE — no verdict is reported for this cell. ' + proof.detail;
    return v;
  }

  const bl = cell.verdict ? cell.verdict.blockers : [];
  v.blockers = bl;
  const s = cell.start || {};
  const startShown = [s.desktop, s.mobile].filter((x) => x && x.visible);
  // THE PROPERTY THAT MATTERS: a page must never present an ENABLED Start when
  // the shared module says a required capability is missing. If it does, the
  // visitor clicks it and gets a black screen with no explanation — which is
  // exactly the reported bug.
  const enabledAndBlocked = bl.length > 0 && startShown.some((x) => !x.disabled);
  v.startEnabled = startShown.map((x) => !x.disabled);
  v.honestGate = !enabledAndBlocked;
  v.reportUsable = !!(cell.report && cell.report.hasHeader && cell.report.noUndefined && cell.report.len > 200);
  v.enginesDiffer = !!arm.enginesDiffer;

  if (bl.length === 0) v.verdict = 'RUNS';
  else if (v.honestGate) v.verdict = 'BLOCKED-HONESTLY';
  else v.verdict = 'FAILS-SILENTLY';
  v.why = bl.length === 0 ? 'all required capabilities present'
        : (cell.verdict && cell.verdict.short) || ('missing: ' + bl.join(','));
  return v;
}

// ---------------------------------------------------------------------------
async function main() {
  const arms = ARMS.filter((a) => !ONLY_ARM || a.id === ONLY_ARM || a.baseline);
  const pages = PAGES.filter((p) => !ONLY_PAGE || p.id === ONLY_PAGE);
  const result = { base: BASE, startedAt: new Date().toISOString(), load: os.loadavg().map((n) => +n.toFixed(2)),
                   cells: [], verdicts: [], rig: null, redirect: null };

  result.rig = await rigSelfTest();
  result.redirect = await redirectTest();

  // Cells run SERIALLY. Concurrent Chrome instances contend for CPU, and this
  // project has measured matched-pair noise at +-25% under load (CLAUDE.md gate
  // #10). Nothing here is a timing measurement except fetchMs, but fetchMs is
  // the slow-net arm's entire proof, so it must not be raced.
  const baselineByPage = {};
  for (const arm of arms) {
    for (const pg of pages) {
      const cell = await runCell(arm, pg);
      result.cells.push(cell);
      if (arm.baseline) baselineByPage[pg.id] = cell;
      result.verdicts.push(judge(arm, pg, cell, baselineByPage[pg.id]));
    }
  }

  result.load = { at_start: result.load, at_end: os.loadavg().map((n) => +n.toFixed(2)) };
  const v = result.verdicts;
  result.summary = {
    cells: v.length,
    runs: v.filter((x) => x.verdict === 'RUNS').length,
    blockedHonestly: v.filter((x) => x.verdict === 'BLOCKED-HONESTLY').length,
    failsSilently: v.filter((x) => x.verdict === 'FAILS-SILENTLY').length,
    voided: v.filter((x) => x.verdict === null).length,
    errors: v.filter((x) => x.verdict === 'ERROR').length,
  };
  // THE GATE. A silent failure is the bug this whole exercise is about. A voided
  // arm is not a pass either: it means the rig did not create the condition.
  result.ok = result.summary.failsSilently === 0 && result.summary.errors === 0
           && result.summary.voided === 0 && result.redirect.ok === true
           && result.rig.isolationHolds === true;

  if (JSON_ONLY) { console.log(JSON.stringify(result, null, 1)); return; }

  // ---- human-readable ----
  const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n).slice(0, n);
  console.log(`\nDEVICE MATRIX  base=${BASE}  load ${result.load.at_start[0]} -> ${result.load.at_end[0]}`);
  console.log('\n--- RIG SELF-TEST (does the fresh-profile guarantee actually hold?) ---');
  console.log(`  fresh profile, n64/ alone      crossOriginIsolated = ${result.rig.freshN64Coi}`);
  console.log(`  same profile, after gamecube   crossOriginIsolated = ${result.rig.n64AfterGcCoi}`);
  console.log(`  leak reproduced = ${result.rig.leakReproduced}   isolation holds = ${result.rig.isolationHolds}`);
  console.log(`  ${result.rig.note}`);

  console.log('\n--- ROOT n64.html REDIRECT ---');
  for (const k of ['js', 'noJs', 'slow', 'query']) {
    const r = result.redirect[k];
    console.log(`  ${pad(k, 6)} HTTP${r.status}  arrived=${pad(r.arrived, 5)} landed=${pad(r.landedOn, 40)}`
      + ` pageWorks=${pad(r.pageWorks, 5)} link=${r.hasVisibleLink}`);
  }
  console.log(`  meta-refresh works with JS disabled = ${result.redirect.metaRefreshWorksWithoutJs}`);
  console.log(`  redirect ok = ${result.redirect.ok}`);

  console.log('\n--- MATRIX ---');
  console.log(`  ${pad('arm', 12)} ${pad('page', 10)} ${pad('verdict', 18)} ${pad('start', 14)} blockers`);
  for (const x of result.verdicts) {
    const st = x.verdict === null ? '' : (x.startEnabled || []).map((e) => (e ? 'enabled' : 'DISABLED')).join(',');
    console.log(`  ${pad(x.arm, 12)} ${pad(x.page, 10)} ${pad(x.verdict === null ? 'VOID (no verdict)' : x.verdict, 18)}`
      + ` ${pad(st, 14)} ${(x.blockers || []).join(',')}`);
    if (x.verdict === null) console.log(`      ${x.void}`);
    else if (x.verdict === 'FAILS-SILENTLY') console.log(`      !! Start is ENABLED but ${x.why}`);
  }

  console.log('\n--- ARM-DIFFERENCE PROOFS (an arm without one measured nothing) ---');
  for (const x of result.verdicts) {
    if (x.page !== pages[0].id) continue;   // one line per arm
    console.log(`  ${pad(x.arm, 12)} ${x.proofHeld ? 'HELD' : 'DID NOT HOLD'} — ${x.proof}`);
  }

  const ed = result.verdicts.filter((x) => x.enginesDiffer);
  if (ed.length) {
    console.log('\n--- LIMIT: these rows ran CHROME\'S ENGINE behind an iOS user agent ---');
    console.log(`  ${[...new Set(ed.map((x) => x.arm))].join(', ')}: viewport/touch/UA are real, WebKit is not.`);
    console.log('  These rows CANNOT clear the pages on real iOS Safari. That needs hardware.');
  }

  console.log(`\nSUMMARY ${JSON.stringify(result.summary)}`);
  console.log(`OK = ${result.ok}\n`);
  const outPath = process.env.MATRIX_OUT || '/tmp/device-matrix.json';
  fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
  console.log(`full JSON -> ${outPath}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
