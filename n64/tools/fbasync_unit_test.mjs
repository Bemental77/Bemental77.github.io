#!/usr/bin/env node
// fbasync_unit_test.mjs — THE ASYNC FRAMEBUFFER READBACK HANDS OVER EXACTLY
// THE PREVIOUS CALL'S PIXELS, WHATEVER THE GPU IS DOING.
//
// The shim under test is the ?fbasync=1 block of n64/index.html, extracted
// from the live file at run time (the only substitution is the query string it
// reads, pinned to "?fbasync=1&fbwitness=1"), so this tests what ships.
//
// It renders frames whose colour is a pure function of the frame number, calls
// readPixels exactly the way Emscripten's _emscripten_glReadPixels does
// (8 arguments: a HEAP view and an element index), and checks what lands in
// the "heap" against the colour of frame k-1 (frame 1, and the first call
// after any invalidation, must hand over ITS OWN frame — the synchronous read).
//
// Two GPU regimes, the point of the test:
//   idle : 30 ms between frames and no extra GPU work — the fence has almost
//          always signalled by the next call;
//   busy : a heavy fragment shader over the whole target every frame and only
//          a 0 ms task boundary — the fence has almost never signalled.
// The shim must hand over identical frame numbers in both (the copy may BLOCK,
// it may never be late by a different amount or be skipped). Both regimes'
// fence-not-signalled fractions are printed: if they do not differ, the test
// has not exercised the thing it claims to and says so (VOID).
//
// USAGE: node n64/tools/fbasync_unit_test.mjs      (no server needed)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '../..');
const html = fs.readFileSync(path.join(root, 'n64/index.html'), 'utf8');
const a = html.indexOf('  var FB_Q = new URLSearchParams(location.search);');
const b = html.indexOf('  var glFacts = { webgl2: false };');
if (a < 0 || b < a) { console.error('could not find the fbasync block in n64/index.html'); process.exit(2); }
const shim = html.slice(a, b).replace('new URLSearchParams(location.search)', "new URLSearchParams('?fbasync=1&fbwitness=1')");

const browser = await puppeteer.launch({ headless: 'new', executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); };
const bad = (n, d) => { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); };
try {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('about:blank');
  await page.evaluate(shim);
  const res = await page.evaluate(async () => {
    const W = 640, H = 480;
    const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
    const gl = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    const col = (k) => [(k * 37) & 255, (k * 11 + 5) & 255, (k * 3 + 7) & 255];
    // A heavy pass that leaves the pixels EXACTLY the clear colour: the loop's
    // result can never reach the step threshold, but the compiler cannot know.
    const vs = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}';
    const fs = '#version 300 es\nprecision highp float;uniform vec4 u;uniform float n;out vec4 o;void main(){float a=0.0;for(float i=0.0;i<n;i+=1.0){a+=sin(gl_FragCoord.x*i+a)*cos(gl_FragCoord.y+i);}o=u+vec4(step(1e30,abs(a)));}';
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
    const HEAP = new Uint8Array(W * H * 4 + 8192), IDX = 4096;
    const st = window.__fbAsync;
    const frame = (k, heavy) => {
      const [r, g, b] = col(k);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(r / 255, g / 255, b / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      if (heavy) {
        gl.useProgram(prog); gl.uniform4f(gl.getUniformLocation(prog, 'u'), r / 255, g / 255, b / 255, 1);
        gl.uniform1f(gl.getUniformLocation(prog, 'n'), 400); gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    };
    // Which frame's colour is in the heap? Checked at 5 spread pixels, all must agree.
    const which = (lo, hi) => {
      const pts = [0, W * 4 * 100 + 400, W * 4 * 240 + 1280, W * 4 * 400 + 2000, W * H * 4 - 4];
      let found = null;
      for (let k = lo; k <= hi; k++) {
        const [r, g, b] = col(k);
        if (pts.every((o) => HEAP[IDX + o] === r && HEAP[IDX + o + 1] === g && HEAP[IDX + o + 2] === b)) { found = k; break; }
      }
      return found;
    };
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const run = async (label, n, heavy, gapMs, kBase) => {
      const out = { label, n, wrong: [], blockedBefore: st.blocked, asyncBefore: st.async, syncBefore: st.sync };
      for (let i = 1; i <= n; i++) {
        const k = kBase + i;
        frame(k, heavy);
        HEAP.fill(0);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, HEAP, IDX);
        const got = which(kBase, k), want = i === 1 ? k : k - 1;
        if (got !== want) out.wrong.push({ i, k, got, want });
        await tick(gapMs);
      }
      out.blocked = st.blocked - out.blockedBefore; out.async = st.async - out.asyncBefore; out.sync = st.sync - out.syncBefore;
      return out;
    };
    const R = {};
    // idle first; an invalidate between regimes so each starts with a sync read
    R.idle = await run('idle', 60, false, 30, 0);
    st.invalidate('test');
    R.busy = await run('busy', 60, true, 0, 100);
    // a rect change: the first call at the new rect hands over its OWN pixels
    frame(200, false); HEAP.fill(0);
    gl.readPixels(0, 0, W, H / 2, gl.RGBA, gl.UNSIGNED_BYTE, HEAP, IDX);
    const [r2, g2, b2] = col(200);
    R.rectSwitchOwn = HEAP[IDX] === r2 && HEAP[IDX + 1] === g2 && HEAP[IDX + 2] === b2;
    frame(201, false); HEAP.fill(0);
    gl.readPixels(0, 0, W, H / 2, gl.RGBA, gl.UNSIGNED_BYTE, HEAP, IDX);
    R.rectSwitchNext = HEAP[IDX] === r2 && HEAP[IDX + 1] === g2 && HEAP[IDX + 2] === b2;   // then N-1 again
    // ROLLBACK / RUN-AHEAD: a snapshot pins the pending copy; after frames that
    // are then thrown away, restore() makes it pending again, so the next call
    // hands over the SNAPSHOT's frame — not the last discarded one.
    const readFull = (k) => { frame(k, false); HEAP.fill(0); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, HEAP, IDX); return which(k - 10, k); };
    const sn = { a: readFull(300), b: readFull(301) };
    const snap = st.snapshot();
    sn.c = readFull(302); sn.d = readFull(303);
    st.restore(snap);
    sn.e = readFull(304); sn.f = readFull(305);
    sn.pinnedBefore = st.pinned; st.release(snap); sn.pinnedAfter = st.pinned;
    // restore twice from one snapshot (two rollbacks to the same frame)
    const snap2 = st.snapshot(); sn.g = readFull(306); st.restore(snap2); sn.h = readFull(307);
    st.restore(snap2); sn.i = readFull(308); st.release(snap2);
    R.snap = sn;
    R.invalidations = st.invalidations; R.lastInvalidation = st.lastInvalidation;
    R.glError = gl.getError();
    R.seqLen = st.seq.length;
    return R;
  });
  for (const k of ['idle', 'busy']) {
    const r = res[k];
    r.wrong.length === 0
      ? ok(`${k}: all ${r.n} calls handed over exactly frame k-1 (the first: its own)`, `async ${r.async}, sync ${r.sync}, fence not signalled at read ${r.blocked}/${r.async}`)
      : bad(`${k}: wrong frame handed over`, JSON.stringify(r.wrong.slice(0, 5)));
  }
  const fi = res.idle.blocked / Math.max(1, res.idle.async), fb = res.busy.blocked / Math.max(1, res.busy.async);
  (fb - fi >= 0.5)
    ? ok('the two regimes really differ at the read point', `fence unsignalled: idle ${(fi * 100).toFixed(0)}% vs busy ${(fb * 100).toFixed(0)}%`)
    : bad('VOID: the regimes did not differ at the read point, so this proves nothing about GPU timing', `idle ${(fi * 100).toFixed(0)}% vs busy ${(fb * 100).toFixed(0)}%`);
  (res.rectSwitchOwn && res.rectSwitchNext && res.lastInvalidation === 'rect')
    ? ok('a rect change reads synchronously once, then resumes the one-call offset')
    : bad('rect change', JSON.stringify({ own: res.rectSwitchOwn, next: res.rectSwitchNext, last: res.lastInvalidation }));
  {
    // a: first call after the H/2 rect -> sync, its own frame (300); b: 300;
    // snapshot pins 301; c: 301, d: 302 (discarded timeline); restore;
    // e: 301 (the pinned copy), f: 304; snapshot2 pins 305; g: 305;
    // restore -> h: 305; restore again -> i: 305.
    const s = res.snap, want = { a: 300, b: 300, c: 301, d: 302, e: 301, f: 304, g: 305, h: 305, i: 305 };
    const badK = Object.keys(want).filter((k) => s[k] !== want[k]);
    (badK.length === 0 && s.pinnedAfter === s.pinnedBefore - 1)
      ? ok('snapshot/restore (rollback, run-ahead): a restored console is handed the pinned copy, twice over', JSON.stringify(s))
      : bad('snapshot/restore', JSON.stringify({ got: s, want }));
  }
  (res.glError === 0 && errs.length === 0) ? ok('no GL error, no page error') : bad('errors', JSON.stringify({ gl: res.glError, errs }));
} finally {
  await browser.close().catch(() => {});
}
console.log(`\n[fbasync-unit] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
