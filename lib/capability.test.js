// lib/capability.test.js — the suite for lib/capability.js. Runs in the page under
// ?captest=1 and publishes window.__capTest = {pass, fail, lines, mutants}.
//
// WHY THIS SUITE IS SHAPED LIKE THIS
// ----------------------------------
// A test nobody has tried to fail is decoration. This project has already been
// bitten by the two failure modes below, so the suite is built to catch both:
//
//   1. A GUARD THAT NEVER FIRES. Every requirement in Capability.REQ gets a
//      MUTANT: one field of a known-good report flipped to the broken value,
//      then an assertion that THAT NAMED guard reports the failure. A guard with
//      no mutant is not tested, so the suite also asserts that the mutant table
//      COVERS EVERY KEY IN REQ — adding a requirement without a mutant fails the
//      suite rather than silently going untested.
//
//   2. A GUARD THAT ALWAYS FIRES. Each mutant is paired with the unmutated
//      report and the guard must stay silent there. A guard that fires on
//      everything catches every bug and locates none.
//
// And the specific bug this whole layer exists to prevent gets its own named
// assertions: PRESENCE-IS-NOT-FUNCTION. `!!navigator.gpu` is `true` on a machine
// with no adapter (measured on this machine 2026-09-01: --disable-gpu and
// --disable-features=WebGPUService,Dawn both leave navigator.gpu truthy and
// resolve requestAdapter() to null). The suite feeds exactly that report in and
// requires the WebGPU guard to call it broken.
(function () {
  'use strict';
  var pass = 0, fail = 0, lines = [], mutants = [];
  function ok(name, cond, detail) {
    if (cond) { pass++; lines.push('CAPTEST PASS ' + name); }
    else { fail++; lines.push('CAPTEST FAIL ' + name + (detail ? '  — ' + detail : '')); }
  }
  function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

  var C = window.Capability;
  ok('module/loaded', !!C);
  if (!C) { finish(); return; }

  // The live-report section below reads probes that are ASYNCHRONOUS
  // (requestAdapter and the worker round-trip both resolve on a later turn).
  // The first cut of this suite ran straight through and failed
  // `live/report-published` on every load — the suite catching its own bug, which
  // is the only reason it is worth having. Everything therefore hangs off
  // Capability.ready, and the module must be allowed to finish measuring before
  // it is asked what it measured.
  C.ready.then(runSuite, function (e) { ok('module/ready-resolved', false, String(e)); finish(); });
  function runSuite() {

  // ---- a KNOWN-GOOD synthetic report: every capability functional -------------
  function good() {
    return {
      ver: 1, page: 'test', ms: 1,
      webgpu: { present: true, adapter: true, device: true, canvasCtx: true, configured: true,
                vendor: 'test', architecture: 'test', device_: 'test', format: 'bgra8unorm', err: null },
      webgl2: { ok: true, webgl1: true, fboComplete: true, stencil: true, depth: true,
                vendor: 'test', renderer: 'test', masked: false, maxTex: 16384, maxRB: 16384, glError: 0, err: null },
      sab: { ctor: true, constructed: true, postable: true, crossOriginIsolated: true, err: null },
      worker: { ctor: true, spawned: true, err: null },
      wasm: { supported: true, threads: true, memory64: false, err: null },
      env: { ua: 'test', iosUA: false, touch: false, maxTouchPoints: 0, vw: 1280, vh: 800, sw: 1280, sh: 800,
             dpr: 1, cores: 8, deviceMemoryGB: 16, jsHeapLimitMB: 4096, lang: 'en',
             netType: '4g', netDownlink: 10, saveData: false, audioWorklet: true, indexedDB: true,
             wakeLock: true, secureContext: true },
      gate: null
    };
  }
  // Requirement spec covering EVERY key in REQ, so the mutation matrix exercises
  // the same code path a page uses.
  function allRequired() {
    var s = {}; Object.keys(C.REQ).forEach(function (k) { s[k] = 'required'; }); return s;
  }

  // ---- 1. the live report's contract -----------------------------------------
  // The rig reads these fields by name off window.__cap on all three pages. A
  // rename here silently blinds tools/device_matrix.mjs, so the shape is pinned.
  var live = C.get();
  ok('live/report-published', !!live, 'Capability.get() returned null — probes had not resolved');
  ok('live/__cap-is-report', window.__cap === live);
  if (live) {
    eq('live/ver', live.ver, C.VER);
    ok('live/page-id', typeof live.page === 'string' && live.page.length > 0);
    ['webgpu', 'webgl2', 'sab', 'worker', 'wasm', 'env'].forEach(function (k) {
      ok('live/section-' + k, live[k] && typeof live[k] === 'object', 'missing section ' + k);
    });
    // Every field the matrix keys on, by name and type.
    ok('live/webgpu.adapter-bool', typeof live.webgpu.adapter === 'boolean');
    ok('live/webgpu.device-bool', typeof live.webgpu.device === 'boolean');
    ok('live/webgpu.present-bool', typeof live.webgpu.present === 'boolean');
    ok('live/webgl2.ok-bool', typeof live.webgl2.ok === 'boolean');
    ok('live/sab.coi-bool', typeof live.sab.crossOriginIsolated === 'boolean');
    ok('live/sab.constructed-bool', typeof live.sab.constructed === 'boolean');
    ok('live/worker.spawned-bool', typeof live.worker.spawned === 'boolean');
    ok('live/wasm.supported-bool', typeof live.wasm.supported === 'boolean');
    ok('live/env.ua-string', typeof live.env.ua === 'string' && live.env.ua.length > 0);
    ok('live/ms-measured', typeof live.ms === 'number' && live.ms >= 0);
    // ── THE REPORT IS PUBLISHED EVEN IF A PROBE HANGS ────────────────────────
    // Every page wires its gate as `Capability.ready.then(… autoGate …)`
    // (gamecube.html:38, dreamcast.html:28, n64/index.html:28). A probe that
    // never settles therefore means autoGate NEVER RUNS and the page keeps an
    // ENABLED Start in front of a broken path — the failure this whole module
    // exists to prevent, reached by a road with no error message on it. The
    // worker probe always bounded itself; the WebGPU chain did not, and
    // requestAdapter()/requestDevice() are driver calls on exactly the hung or
    // blocklisted GPU this layer is for. run() is now bounded, and an
    // unfinished probe is published as a NAMED timeout instead of never
    // arriving. These two assertions pin the contract that makes that visible.
    ok('live/timedOut-is-reported', typeof live.timedOut === 'boolean',
       'report.timedOut must always be present so a hung probe is a FACT in the report, not a silence');
    ok('live/publish-is-bounded', live.ms < 15000,
       'the report took ' + Math.round(live.ms) + ' ms to publish — the probe budget did not bound it, '
       + 'and a page whose gate waits this long has shown an enabled Start the whole time');
    // THE PROBES ACTUALLY RAN. A report full of nulls would satisfy every shape
    // assertion above while measuring nothing — this is the assertion that the
    // WebGPU chain was walked rather than skipped.
    ok('live/webgpu-probe-ran', live.webgpu.adapter === true || typeof live.webgpu.err === 'string',
       'adapter false with no err means the probe never ran');
    // The worker probe is the one that can time out; it must report either a
    // spawn or a reason, never silence.
    ok('live/worker-probe-ran', live.worker.spawned === true || typeof live.worker.err === 'string');
    // Self-consistency: SAB cannot be postable if it was never constructed.
    ok('live/sab-consistent', !(live.sab.postable === true && live.sab.constructed === false));
    // WebGL2 FBO is only meaningful when a context exists.
    ok('live/webgl2-consistent', live.webgl2.ok === true ? (typeof live.webgl2.fboComplete === 'boolean')
                                                         : (live.webgl2.fboComplete === null));
  }

  // ---- 2. PRESENCE IS NOT FUNCTION — the bug this layer exists to prevent -----
  // Each of these reports is what a REAL machine produced under a real flag. The
  // naive `!!navigator.gpu` check passes all of them; the guard must not.
  (function () {
    var r = good();
    r.webgpu = { present: true, adapter: false, device: false, canvasCtx: false, configured: false,
                 err: 'requestAdapter() resolved null' };
    C._setReport(r);
    var b = C.blockers({ webgpu: 'required' });
    eq('presence/adapter-null-is-blocked', b.length, 1);
    ok('presence/adapter-null-names-webgpu', b.length === 1 && b[0].id === 'webgpu');
    ok('presence/naive-check-would-have-passed', r.webgpu.present === true,
       'the fixture must be the deceptive one: navigator.gpu truthy, adapter null');
    ok('presence/why-quotes-the-reason', b.length === 1 && /requestAdapter/.test(b[0].why));
    ok('presence/fix-is-actionable', b.length === 1 && b[0].fix.length > 30);

    // Adapter but no device: the second link. Also passes a naive check.
    r = good(); r.webgpu = { present: true, adapter: true, device: false, canvasCtx: false, configured: false, err: 'no device' };
    C._setReport(r);
    eq('presence/device-null-is-blocked', C.blockers({ webgpu: 'required' }).length, 1);

    // SAB constructor present but the postMessage rejected — the engine behaviour
    // that looks like an emulator bug rather than a missing header.
    r = good(); r.sab = { ctor: true, constructed: true, postable: false, crossOriginIsolated: true, err: 'DataCloneError' };
    C._setReport(r);
    var bs = C.blockers({ sab: 'required' });
    eq('presence/sab-unpostable-is-blocked', bs.length, 1);
    ok('presence/sab-unpostable-names-sab', bs.length === 1 && bs[0].id === 'sab');

    // WebGL2 context present but no FBO: advertised support, unusable in practice.
    r = good(); r.webgl2.fboComplete = false;
    C._setReport(r);
    eq('presence/webgl2-no-fbo-blocked', C.blockers({ webgl2fbo: 'required' }).length, 1);
    eq('presence/webgl2-no-fbo-passes-plain-webgl2', C.blockers({ webgl2: 'required' }).length, 0);
  })();

  // ---- 3. THE MUTATION MATRIX ------------------------------------------------
  // One mutant per requirement. Each states the field it breaks, so a reader can
  // see at a glance what is and is not covered.
  var MUT = {
    webgpu:      function (r) { r.webgpu.adapter = false; r.webgpu.device = false; r.webgpu.err = 'no adapter'; },
    webgl2:      function (r) { r.webgl2.ok = false; r.webgl2.err = 'getContext returned null'; },
    webgl2fbo:   function (r) { r.webgl2.fboComplete = false; },
    // NOT independent of `sab`, and the mutant must reflect that. A browser with
    // `crossOriginIsolated === false` cannot hand out a usable SharedArrayBuffer
    // — the two travel together. The earlier mutant flipped ONLY the flag, which
    // after the presence->function fix in capability.js is precisely the case
    // that must NOT block (flag says no, SAB demonstrably works). Five tests
    // failed on that mutant and they were right to: it no longer described a
    // real device.
    // `coi` earns its place as a separate blocker through its MESSAGE ("reload
    // once, the service worker installs the headers"), not through being an
    // independent failure axis.
    coi:         function (r) { r.sab.crossOriginIsolated = false; r.sab.constructed = false; r.sab.postable = false; r.sab.err = 'cross-origin isolation absent'; },
    sab:         function (r) { r.sab.constructed = false; r.sab.err = 'SharedArrayBuffer is not defined'; },
    worker:      function (r) { r.worker.spawned = false; r.worker.err = 'worker did not respond'; },
    wasm:        function (r) { r.wasm.supported = false; r.wasm.err = 'WebAssembly unavailable'; },
    wasmThreads: function (r) { r.wasm.threads = false; r.wasm.err = 'shared memory refused'; }
  };

  // COVERAGE: a requirement with no mutant is an untested guard. Fail loudly
  // rather than quietly shrinking the matrix when someone adds a requirement.
  Object.keys(C.REQ).forEach(function (k) {
    ok('matrix/covers-' + k, typeof MUT[k] === 'function', 'REQ.' + k + ' has no mutant — the guard is untested');
  });
  Object.keys(MUT).forEach(function (k) {
    ok('matrix/mutant-targets-real-req-' + k, !!C.REQ[k], 'mutant ' + k + ' targets no requirement');
  });

  // CONTROL: the unmutated report must clear every guard. If this fails, a
  // "caught" mutant below proves nothing — the guard was firing anyway.
  C._setReport(good());
  var baseB = C.blockers(allRequired());
  eq('matrix/control-clean', baseB.length, 0,
     'good report was blocked by: ' + baseB.map(function (x) { return x.id; }).join(','));
  eq('matrix/control-verdict-ok', C.verdict(allRequired()).level, 'ok');

  Object.keys(MUT).forEach(function (id) {
    var r = good(); MUT[id](r); C._setReport(r);
    var b = C.blockers(allRequired());
    var ids = b.map(function (x) { return x.id; });
    var caught = ids.indexOf(id) >= 0;
    mutants.push({ id: id, caught: caught, firedAlso: ids.filter(function (x) { return x !== id; }) });
    // (a) the NAMED guard fires for its own mutant
    ok('mutant/' + id + '/caught-by-its-own-guard', caught, 'fired: [' + ids.join(',') + ']');
    // (b) the verdict a human reads actually degrades — a guard that fires into a
    //     silent verdict is invisible where it matters
    eq('mutant/' + id + '/verdict-degrades', C.verdict(allRequired()).level, 'bad');
    // (c) the verdict NAMES the missing capability, not just "something broke"
    ok('mutant/' + id + '/verdict-names-it', C.verdict(allRequired()).short.indexOf(C.REQ[id].what) >= 0,
       'verdict: ' + C.verdict(allRequired()).short);
    // (d) a reason and a visitor-actionable fix, both non-empty
    var mine = b.filter(function (x) { return x.id === id; })[0];
    ok('mutant/' + id + '/has-why', !!(mine && mine.why && mine.why.length > 5));
    ok('mutant/' + id + '/has-fix', !!(mine && mine.fix && mine.fix.length > 20));
    // (e) NO FALSE POSITIVE: this guard must stay silent on the good report.
    C._setReport(good());
    var solo = {}; solo[id] = 'required';
    eq('mutant/' + id + '/silent-on-good', C.blockers(solo).length, 0);
  });

  // Cross-check: mutating ONE capability must not blame an UNRELATED one. Coupled
  // guards are legitimate (no COI implies no SAB on Chrome), so this only pins
  // the pairs that are genuinely independent.
  (function () {
    var independent = [['webgpu', 'webgl2'], ['webgpu', 'worker'], ['webgl2', 'sab'], ['worker', 'webgl2']];
    independent.forEach(function (pair) {
      var r = good(); MUT[pair[0]](r); C._setReport(r);
      var ids = C.blockers(allRequired()).map(function (x) { return x.id; });
      ok('isolation/' + pair[0] + '-does-not-blame-' + pair[1], ids.indexOf(pair[1]) < 0,
         'breaking ' + pair[0] + ' also blamed ' + pair[1]);
    });
  })();

  // ---- 4. per-page requirement specs -----------------------------------------
  // The three shipped specs, asserted against the good report and against the
  // mutant that is each page's actual real-world failure.
  // Read from the MODULE, not re-declared here. A local copy would let the
  // shipped specs drift while the suite kept passing against its own fiction —
  // this project has already lost a campaign to two "different" configs that
  // were identical.
  var SPECS = C.SPECS;
  ok('spec/published-by-module', !!SPECS);
  ['gamecube', 'dreamcast', 'n64'].forEach(function (p) {
    ok('spec/' + p + '/exists', !!(SPECS && SPECS[p]));
    ok('spec/' + p + '/every-key-is-a-real-requirement',
       !!SPECS[p] && Object.keys(SPECS[p]).every(function (k) { return !!C.REQ[k]; }),
       'unknown requirement in ' + p + ' spec');
    ok('spec/' + p + '/every-value-is-a-level',
       !!SPECS[p] && Object.keys(SPECS[p]).every(function (k) { return SPECS[p][k] === 'required' || SPECS[p][k] === 'degraded'; }));
  });
  C._setReport(good());
  Object.keys(SPECS).forEach(function (p) { eq('spec/' + p + '/clean-on-good', C.blockers(SPECS[p]).length, 0); });

  // n64 is the PORTABILITY REFERENCE: it must not require any of the three
  // things that make the other two pages fragile. This is the assertion that
  // catches someone "helpfully" adding SAB to the n64 spec.
  ok('spec/n64/needs-no-webgpu', !SPECS.n64.webgpu);
  ok('spec/n64/needs-no-sab', !SPECS.n64.sab);
  ok('spec/n64/needs-no-coi', !SPECS.n64.coi);

  // ── THE PRESENCE-vs-FUNCTION CASE, and why it is pinned here ──────────────
  // `coi.has` originally read `r.sab.crossOriginIsolated` — a REPORTED FLAG —
  // while `sab.has` right below it did the honest functional test. OBSERVED on
  // a real browser: the banner said "missing cross-origin isolation" and Start
  // was disabled IN THE SAME RUN where the emulator booted and rendered.
  // `coi` is `required` in BOTH the gamecube and dreamcast specs, so that false
  // negative gated the product on two pages.
  //
  // The rule this file's own header states is "TEST FUNCTION, NOT PRESENCE",
  // and this is the case that proves the blocker obeys it. Both directions are
  // asserted, because a blocker that never blocks is as broken as one that
  // always does.
  (function () {
    // Flag says NOT isolated, but SharedArrayBuffer demonstrably works.
    var r = good();
    r.sab.crossOriginIsolated = false;
    r.sab.constructed = true; r.sab.postable = true;
    C._setReport(r);
    var names = C.blockers(SPECS.gamecube).map(function (b) { return b.key || b.what || String(b); });
    ok('coi/functional-sab-overrides-false-flag',
       names.join(',').indexOf('cross-origin') === -1,
       'coi must NOT block when SAB constructs and is postable; blockers=' + names.join(','));

    // Converse: flag false AND SharedArrayBuffer genuinely broken -> coi blocks.
    var r2 = good();
    r2.sab.crossOriginIsolated = false;
    r2.sab.constructed = false; r2.sab.postable = false; r2.sab.err = 'blocked';
    C._setReport(r2);
    var names2 = C.blockers(SPECS.gamecube).map(function (b) { return b.key || b.what || String(b); });
    ok('coi/still-blocks-when-sab-really-broken',
       names2.join(',').indexOf('cross-origin') !== -1,
       'coi MUST block when SAB cannot be constructed; blockers=' + names2.join(','));
  })();
  (function () {
    var r = good(); MUT.webgpu(r); MUT.coi(r); MUT.sab(r); C._setReport(r);
    eq('spec/n64/survives-no-webgpu-no-sab-no-coi', C.blockers(SPECS.n64).length, 0);
    ok('spec/gamecube/blocked-by-no-webgpu', C.blockers(SPECS.gamecube).length > 0);
    ok('spec/dreamcast/blocked-by-no-sab', C.blockers(SPECS.dreamcast).length > 0);
  })();
  // ...and the converse: with no WebGL2, n64 IS blocked. A spec that never
  // blocks is not a spec.
  (function () {
    var r = good(); MUT.webgl2(r); C._setReport(r);
    eq('spec/n64/blocked-by-no-webgl2', C.blockers(SPECS.n64).length, 1);
  })();

  // ---- 5. gate(): the mechanical "no enabled Start behind a broken path" ------
  (function () {
    var el = document.createElement('button');
    el.textContent = 'Start'; document.body.appendChild(el);

    C._setReport(good());
    var g1 = C.gate(el, SPECS.gamecube);
    eq('gate/good-not-blocked', g1.blocked, false);
    eq('gate/good-leaves-enabled', el.disabled, false);
    eq('gate/good-keeps-label', el.textContent, 'Start');
    eq('gate/records-on-report', C.get().gate, g1);

    var r = good(); MUT.webgpu(r); C._setReport(r);
    var g2 = C.gate(el, SPECS.gamecube);
    eq('gate/blocked-flag', g2.blocked, true);
    eq('gate/actually-disables', el.disabled, true);
    ok('gate/marks-element', el.getAttribute('data-cap-blocked') === 'webgpu');
    ok('gate/relabels-honestly', el.textContent !== 'Start' && /WebGPU/.test(el.textContent),
       'label: ' + el.textContent);
    ok('gate/title-explains', /What you can do/.test(el.title || ''));
    eq('gate/applied', g2.applied, true);

    // The escape hatch is opt-in AND recorded — a page can never quietly
    // re-enable itself without the report saying so.
    var el2 = document.createElement('button'); el2.textContent = 'Start'; document.body.appendChild(el2);
    var g3 = C.gate(el2, SPECS.gamecube, { allowAnyway: true });
    eq('gate/override-still-reports-blocked', g3.blocked, true);
    eq('gate/override-recorded', g3.overridden, true);
    eq('gate/override-leaves-enabled', el2.disabled, false);
    eq('gate/override-did-not-apply', g3.applied, false);

    // ---- the two-layer ownership protocol ------------------------------------
    // gamecube.html:1674 refuses to re-enable a button carrying
    // aria-disabled="true", treating it as "the capability layer is holding
    // this". That deference is only safe if this layer RELEASES the mark when it
    // stops blocking — otherwise a stale attribute pins Start down forever and
    // the other layer, behaving exactly as agreed, never re-enables it.
    var el3 = document.createElement('button'); el3.textContent = 'Start'; document.body.appendChild(el3);
    var rb = good(); MUT.webgpu(rb); C._setReport(rb);
    C.gate(el3, SPECS.gamecube);
    eq('gate/protocol/marks-aria-while-blocking', el3.getAttribute('aria-disabled'), 'true');
    eq('gate/protocol/marks-authorship', el3.getAttribute('data-cap-blocked'), 'webgpu');
    // IT MUST LOOK DEAD, not just BE dead. The mobile splash Start is styled an
    // inviting green on all three pages, and a screenshot of the gated GameCube
    // page showed a bright green call-to-action reading "Cannot run here" — a
    // control that still LOOKS actionable is still being presented.
    ok('gate/protocol/looks-disabled', el3.style.cursor === 'not-allowed' && +el3.style.opacity < 1
       && /2a2a2a|rgb\(42, 42, 42\)/.test(el3.style.background),
       'style: cursor=' + el3.style.cursor + ' opacity=' + el3.style.opacity + ' bg=' + el3.style.background);
    // ── AND IT MUST BE UNTAPPABLE, WHICH `disabled` DOES NOT ACHIEVE ──────────
    // MEASURED 2026-09-01, Chrome 140, ONE REAL TOUCH TAP on a <button> with
    // `disabled = true` — which was the gate's entire lockout until this fix:
    //
    //     event         enabled control   disabled   disabled + pointer-events:none
    //     pointerdown          2              2                    0
    //     touchstart           1              1                    0
    //     click                2              0                    0
    //     mousedown            2              0                    0
    //
    // Chrome suppresses `click` and `mousedown` on a disabled form control and
    // does NOT suppress `pointerdown` or `touchstart`. Both mobile splash Start
    // handlers are bound to `pointerdown` (gamecube.html and n64/index.html
    // `preventDefault()` and then call `startEmulator()` directly), so on a
    // PHONE the gate was defeated by one tap. MEASURED on the shipped pages
    // under --disable-gpu at an iPhone viewport, tapping the greyed-out button
    // reading "Cannot run here — This device is missing WebGPU.":
    //   gamecube.html  splash flex->none, __gcStartedAtMs set, ppc-worker
    //                  spawned — black canvas, explanation now hidden.
    //   n64/index.html splash flex->none, honest message replaced by
    //                  "Load failed: Cannot read properties of undefined
    //                  (reading 'getParameter')".
    // The device matrix scored BOTH of those cells `BLOCKED-HONESTLY /
    // DISABLED`, because it read `.disabled` and never tapped.
    eq('gate/protocol/pointer-events-none-while-blocking', el3.style.pointerEvents, 'none');
    // The FUNCTIONAL form of the same assertion, and the one that would still
    // fail if someone "cleaned up" the inline style into a class that does not
    // land. `pointer-events` is a HIT-TESTING property, so it is measured by
    // hit-testing — a synthetic dispatchEvent() would bypass exactly the
    // mechanism under test and pass no matter what.
    (function () {
      var probe = document.createElement('button');
      probe.textContent = 'Start';
      // Fixed + maximal z-index so nothing on the host page (the capability
      // banner is position:fixed at the top) can occlude it and make this
      // inconclusive.
      probe.style.cssText = 'position:fixed;left:12px;top:40%;width:180px;height:56px;z-index:2147483647';
      document.body.appendChild(probe);
      function topAt() {
        var r = probe.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      }
      function hitsProbe() { return topAt() === probe; }
      // If something on the host page sits above the probe, the assertions below
      // would fail for a reason that has nothing to do with the gate. Name what
      // is in the way so that failure is diagnosable instead of mysterious.
      function occludedBy() {
        var t = topAt();
        if (!t || t === probe) return '';
        return ' (topmost element at that point is <' + t.tagName.toLowerCase()
             + (t.id ? '#' + t.id : '') + '> — the host page is occluding the probe, '
             + 'so this assertion is about layout, not about the gate)';
      }
      // CONTROL 1: laid out and on top — the hit test finds it.
      var beforeAnything = hitsProbe();
      var occl = beforeAnything ? '' : occludedBy();
      // CONTROL 2: `disabled` ALONE still leaves it the hit-test target. This is
      // the assertion that makes the one below non-vacuous: if a future Chrome
      // starts excluding disabled controls from hit testing, this flips and the
      // suite says so instead of quietly passing for the wrong reason.
      probe.disabled = true;
      var withDisabledOnly = hitsProbe();
      // THE FIX: gate() must take it out of hit testing entirely.
      var rb2 = good(); MUT.webgpu(rb2); C._setReport(rb2);
      C.gate(probe, SPECS.gamecube);
      var whileGated = hitsProbe();
      // ...and give it back when the device recovers, or a working control is
      // permanently untappable — the same dead button in the other direction.
      C._setReport(good());
      C.gate(probe, SPECS.gamecube);
      probe.disabled = false;
      var afterRelease = hitsProbe();
      ok('gate/hittest/control-plain-button-is-hit', beforeAnything,
         'the probe button was not the hit-test target even before gating' + occl);
      ok('gate/hittest/control-disabled-alone-is-STILL-hit', withDisabledOnly,
         'disabled alone no longer hit-tests in this engine; the pointerdown hazard may be gone, '
         + 'but the assertion below is now vacuous and this suite should be revisited' + occl);
      ok('gate/hittest/gated-control-is-NOT-hit', !whileGated,
         'a GATED Start is still the hit-test target — pointerdown reaches it and the mobile '
         + 'splash handlers start the emulator anyway');
      ok('gate/hittest/released-control-is-hit-again', afterRelease,
         'gate() released its marks but left the control untappable' + occl);
      eq('gate/protocol/restores-pointer-events-on-release', probe.style.pointerEvents, '');
      document.body.removeChild(probe);
    })();
    // Put the blocked fixture back: the assertions after this block continue the
    // release-protocol sequence and must not inherit the good report installed
    // by the hit-test probe above.
    C._setReport((function () { var x = good(); MUT.webgpu(x); return x; })());
    C.gate(el3, SPECS.gamecube);
    // ...capability comes back (a retry, a reload into a working profile):
    C._setReport(good());
    var g5 = C.gate(el3, SPECS.gamecube);
    eq('gate/protocol/releases-aria-when-unblocked', el3.getAttribute('aria-disabled'), null);
    eq('gate/protocol/releases-authorship-mark', el3.getAttribute('data-cap-blocked'), null);
    eq('gate/protocol/reports-release', g5.released, true);
    // ...and the page's own styling comes back, not a grey button left behind.
    eq('gate/protocol/restores-look-on-release', el3.style.cursor, '');
    eq('gate/protocol/restores-opacity-on-release', el3.style.opacity, '');
    eq('gate/protocol/restores-tappability-on-release', el3.style.pointerEvents, '');
    // It must NOT clear `disabled` itself: the other layer may be holding the
    // button for a render-path reason this layer knows nothing about.
    ok('gate/protocol/does-not-force-enable', el3.disabled === true,
       'releasing our marks must not re-enable a button the other layer may own');
    // And it must not touch an aria-disabled it did not author.
    var el4 = document.createElement('button'); document.body.appendChild(el4);
    el4.setAttribute('aria-disabled', 'true');            // someone else's mark
    C._setReport(good());
    C.gate(el4, SPECS.gamecube);
    eq('gate/protocol/leaves-foreign-aria-alone', el4.getAttribute('aria-disabled'), 'true');
    document.body.removeChild(el3); document.body.removeChild(el4);

    // A null element must not throw — pages call gate() before their DOM exists.
    // The report is re-broken explicitly: this assertion is about a BLOCKED
    // verdict surviving a missing element, so it must not inherit whatever state
    // the previous block happened to leave installed. (It did inherit it once,
    // and the suite failed here the moment a block was inserted above.)
    C._setReport((function () { var x = good(); MUT.webgpu(x); return x; })());
    var g4 = C.gate(null, SPECS.gamecube);
    eq('gate/null-element-safe', g4.blocked, true);
    document.body.removeChild(el); document.body.removeChild(el2);
  })();

  // ---- 5b. autoGate(): both Start controls, the banner, and the override -----
  // The original bug report came from a PHONE, and the mobile splash Start is a
  // different element from the desktop one on all three pages. A gate that
  // covers only #btnStart leaves the reporting device with an enabled button in
  // front of a broken path — so both are asserted, separately, by name.
  (function () {
    function mkStarts() {
      ['btnStart', 'mobileSplashStart'].forEach(function (id) {
        var b = document.createElement('button'); b.id = id; b.textContent = 'Start';
        document.body.appendChild(b);
      });
    }
    function rmStarts() {
      ['btnStart', 'mobileSplashStart'].forEach(function (id) {
        var e = document.getElementById(id); if (e) e.parentNode.removeChild(e);
      });
      var b = document.getElementById('capBanner'); if (b) b.parentNode.removeChild(b);
    }
    // good device -> nothing disabled, no banner
    rmStarts(); mkStarts();
    C._setReport(good());
    C.autoGate(SPECS.gamecube);
    eq('autogate/good/desktop-enabled', document.getElementById('btnStart').disabled, false);
    eq('autogate/good/mobile-enabled', document.getElementById('mobileSplashStart').disabled, false);
    eq('autogate/good/no-banner', !!document.getElementById('capBanner'), false);

    // broken device -> BOTH disabled, banner present and specific
    rmStarts(); mkStarts();
    var r = good(); MUT.webgpu(r); C._setReport(r);
    C.autoGate(SPECS.gamecube);
    eq('autogate/broken/desktop-DISABLED', document.getElementById('btnStart').disabled, true);
    eq('autogate/broken/mobile-DISABLED', document.getElementById('mobileSplashStart').disabled, true);
    ok('autogate/broken/desktop-marked', document.getElementById('btnStart').getAttribute('data-cap-blocked') === 'webgpu');
    ok('autogate/broken/mobile-marked', document.getElementById('mobileSplashStart').getAttribute('data-cap-blocked') === 'webgpu');
    var ban = document.getElementById('capBanner');
    ok('autogate/broken/banner-shown', !!ban);
    ok('autogate/broken/banner-names-capability', !!ban && /WebGPU/.test(ban.textContent));
    // "what the visitor can do about it" is the half that is usually missing.
    ok('autogate/broken/banner-says-what-to-do', !!ban && /What you can do/.test(ban.textContent));
    ok('autogate/broken/banner-offers-report', !!ban && /Share report/.test(ban.textContent)
       && /Copy report/.test(ban.textContent));
    ok('autogate/broken/banner-offers-override', !!ban && /Try anyway/.test(ban.textContent));
    // The banner must not be built twice if autoGate runs again.
    C.autoGate(SPECS.gamecube);
    eq('autogate/idempotent-banner', document.querySelectorAll('#capBanner').length, 1);

    // override -> enabled, banner still shown, and the override RECORDED
    rmStarts(); mkStarts();
    C._setReport(r);
    var g = C.autoGate(SPECS.gamecube, { allowAnyway: true });
    eq('autogate/override/desktop-enabled', document.getElementById('btnStart').disabled, false);
    eq('autogate/override/mobile-enabled', document.getElementById('mobileSplashStart').disabled, false);
    eq('autogate/override/recorded-on-report', C.get().gate.overridden, true);
    ok('autogate/override/still-reports-blocked', g.blocked === true);
    ok('autogate/override/banner-still-shown', !!document.getElementById('capBanner'),
       'an override must not hide the reason');

    // n64's spec on a device with no WebGPU/SAB/COI: the portability reference
    // must NOT be gated by any of them.
    rmStarts(); mkStarts();
    var r2 = good(); MUT.webgpu(r2); MUT.coi(r2); MUT.sab(r2); C._setReport(r2);
    C.autoGate(SPECS.n64);
    eq('autogate/n64/not-gated-by-webgpu-sab-coi', document.getElementById('btnStart').disabled, false);
    eq('autogate/n64/no-banner', !!document.getElementById('capBanner'), false);
    rmStarts();

    // A page with no Start elements at all must not throw.
    C._setReport(r);
    var g2 = C.autoGate(SPECS.gamecube);
    ok('autogate/no-start-elements-safe', !!g2);
    var b2 = document.getElementById('capBanner'); if (b2) b2.parentNode.removeChild(b2);
  })();

  // ---- 6. degraded vs required -----------------------------------------------
  (function () {
    var r = good(); MUT.webgpu(r); C._setReport(r);
    eq('degraded/not-a-blocker', C.blockers({ webgpu: 'degraded' }).length, 0);
    eq('degraded/is-listed', C.degraded({ webgpu: 'degraded' }).length, 1);
    eq('degraded/verdict-warn-not-bad', C.verdict({ webgpu: 'degraded' }).level, 'warn');
    // required outranks degraded when both are present
    eq('degraded/required-wins', C.verdict({ webgpu: 'required', webgl2: 'degraded' }).level, 'bad');
  })();

  // ---- 7. the report text ----------------------------------------------------
  (function () {
    C._setReport(good());
    var t = C.text();
    ok('text/has-capability-header', /--- CAPABILITY/.test(t));
    ok('text/states-adapter', /adapter=yes/.test(t));
    ok('text/states-coi', /crossOriginIsolated=yes/.test(t));
    ok('text/states-ua', /\[cap\] test/.test(t));
    ok('text/extra-appended', C.text('EXTRA-MARKER').indexOf('EXTRA-MARKER') >= 0);
    var r = good(); MUT.webgpu(r); C._setReport(r);
    var t2 = C.text();
    // The failure REASON must survive into the shareable text — a report that
    // says "adapter=NO" without saying why sends the reader nowhere.
    ok('text/carries-failure-reason', /WebGPU why: no adapter/.test(t2), t2.split('\n').slice(0, 6).join(' | '));
    ok('text/adapter-no-when-broken', /adapter=NO/.test(t2));
    // Booleans must never print as "undefined" — the field is the whole message.
    ok('text/no-undefined-leaks', t2.indexOf('undefined') < 0, t2);
  })();

  // ---- 8. probes are non-destructive -----------------------------------------
  // The capability probe runs on every page load, so it must not consume the
  // thing it is measuring. These re-run the real probes and require the second
  // answer to match the first.
  (function () {
    var l = live;
    if (!l) { ok('nondestructive/skipped-no-live-report', true); return; }
    var c = document.createElement('canvas'); c.width = c.height = 1;
    var gl2 = null; try { gl2 = c.getContext('webgl2', { depth: true, stencil: true }); } catch (e) {}
    ok('nondestructive/webgl2-still-available', (!!gl2) === l.webgl2.ok,
       'probe left WebGL2 in a different state than it found it');
    ok('nondestructive/sab-ctor-unchanged', (typeof SharedArrayBuffer === 'function') === l.sab.ctor);
    ok('nondestructive/coi-unchanged', (!!self.crossOriginIsolated) === l.sab.crossOriginIsolated);
  })();

  // The live report was replaced by synthetic fixtures all through the matrix
  // above. Put the REAL one back before the page (or a rig) reads window.__cap,
  // or every arm of the device matrix would read the last mutant instead of the
  // device. This restoration is itself asserted, below.
  C._setReport(live);
  ok('restore/__cap-is-the-real-report', window.__cap === live && C.get() === live,
     'the suite left a synthetic fixture in window.__cap');

  finish();
  }

  // Published ONLY when the suite has actually finished. An earlier cut also
  // called finish() synchronously at the bottom of the file, which raced the
  // async suite: a rig polling for `window.__capTest` could latch a 1-assertion
  // result and call it clean. `done` is the flag rigs gate on, and `expect` is
  // the floor that catches a suite which silently stopped running most of itself.
  function finish() {
    // `expect` is the FLOOR a rig checks `pass` against, because a suite that
    // silently stopped running most of itself also reports zero failures. It was
    // 100 while the suite was measured at 189, which is a floor so far below the
    // real count that half the suite could vanish and still clear it. MEASURED
    // 2026-09-01 after the pointer-events and watchdog assertions were added:
    // 198 passing, 0 failing, identically on gamecube.html, dreamcast.html and
    // n64/index.html. 180 leaves room to retire a handful of assertions on
    // purpose while still catching a suite that died partway.
    window.__capTest = { done: true, pass: pass, fail: fail, expect: 180, lines: lines, mutants: mutants };
    var msg = '[captest] ' + pass + ' passed, ' + fail + ' failed';
    if (fail) { lines.filter(function (l) { return l.indexOf('CAPTEST FAIL') === 0; }).forEach(function (l) { console.error(l); }); }
    console.log(msg);
  }
})();
