// tools/headless_cdp.mjs — headless Chrome over BARE CDP (no puppeteer), with a machine-wide lock.
//
// WHY: the user's rule (memory: browser-work-headless-only) is that page checks run in a SEPARATE headless
// Chrome with a THROWAWAY profile, never in their own browser and never via the Claude-in-Chrome tools. This
// is the one shared implementation so every rig does it identically.
//
//   import { withBrowser } from './headless_cdp.mjs';
//   await withBrowser({ port: 9222, width: 390, height: 844 }, async (page) => {
//     await page.navigate('http://localhost:8091/pokemonarena/');
//     const v = await page.eval('document.title');
//     await page.screenshot('C:/path/out.png');
//   });
//
// * ONE browser at a time machine-wide (mkdir lock; stale locks from dead owners are reaped), because several
//   agents running Chrome + emulators at once is what drove this box to load 83 (CLAUDE.md "Before any measured run").
// * The browser is registered with tools/browser_leak_guard.js so `reap` can kill it if the owner is SIGKILLed.
// * Chrome is killed (process tree) and the profile deleted in a finally.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK = process.env.BROWSER_LOCK_DIR || path.join(os.tmpdir(), 'bemental-browser.lock');

export const CHROME = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// THE LOCK HAS SLOTS (changed 2026-11-02: one browser at a time left five agents queueing for hours on a 16-CPU box that sat at 1-20% load).
//   * Shared (default): up to BROWSER_LOCK_SLOTS (default 3) browsers at once, one directory per slot (<lock>.s0 .. .sN-1).
//   * Exclusive (BROWSER_LOCK_EXCLUSIVE=1, or acquireBrowserLock({ exclusive: true })): the whole machine for this run. Use it for anything that
//     ASSERTS or REPORTS timing (frame pacing, guest-rate / gate-9 windows, budget measurements): it takes the legacy lock directory, which stops
//     new shared holders, then waits for every slot to drain. Shared holders never wait for anything while they hold a slot, so this cannot deadlock.
//   * A process still running the OLD single-directory code holds the legacy directory. Shared runs do not wait for it (it counts as one extra
//     browser); an exclusive run takes the legacy directory too, so it does wait for it.
function lockHeld(dir) {      // true when a live owner holds dir; a stale one (dead pid) is removed
  let first;
  try { first = fs.readFileSync(path.join(dir, 'owner'), 'utf8').split(' ')[0]; } catch (_e) { return fs.existsSync(dir); }   // no owner file yet: held (or absent)
  const pid = Number(first);
  if (pid && !pidAlive(pid)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} return false; }
  return true;
}
function takeDir(dir) {
  try { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner'), `${process.pid} ${new Date().toISOString()}`); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}
function dropDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} }

// THE LOCK IS OFF BY DEFAULT (owner directive 2026-11-02: "we dont need your self imposed lock"). Runs go in parallel. Opt back in with
// BROWSER_LOCK=1 (the slot logic above) for a measurement that must have the machine to itself; report the machine load with such numbers.
export async function acquireBrowserLock({ timeoutMs = Number(process.env.BROWSER_LOCK_TIMEOUT_MS) || 900000, pollMs = 3000, exclusive = process.env.BROWSER_LOCK_EXCLUSIVE === '1' } = {}) {       // BROWSER_LOCK_TIMEOUT_MS: a queued run may wait longer than 15 minutes for its turn (the lock is still taken, never skipped)
  if (process.env.BROWSER_LOCK !== '1') return () => {};
  const t0 = Date.now();
  const slots = Math.max(1, Number(process.env.BROWSER_LOCK_SLOTS) || 3);
  const slotDir = (i) => LOCK + '.s' + i;
  const XFLAG = LOCK + '.x';
  const timedOut = () => new Error('browser lock timeout after ' + timeoutMs + ' ms (' + LOCK + (exclusive ? ', exclusive' : ', ' + slots + ' slots') + ')');
  if (exclusive) {
    for (;;) {                                           // 1. take the legacy directory (old-code holders and other exclusive runs), then the exclusive flag: no new shared holder starts while we hold it
      if (!lockHeld(LOCK) && takeDir(LOCK)) { if (takeDir(XFLAG) || (!lockHeld(XFLAG) && takeDir(XFLAG))) break; dropDir(LOCK); }
      if (Date.now() - t0 > timeoutMs) throw timedOut();
      await sleep(pollMs);
    }
    for (;;) {                                           // 2. wait for the shared holders already running to finish
      let busy = false;
      for (let i = 0; i < slots; i++) if (lockHeld(slotDir(i))) busy = true;
      if (!busy) return () => { dropDir(XFLAG); dropDir(LOCK); };
      if (Date.now() - t0 > timeoutMs) { dropDir(XFLAG); dropDir(LOCK); throw timedOut(); }
      await sleep(pollMs);
    }
  }
  for (;;) {
    if (!lockHeld(XFLAG)) {
      for (let i = 0; i < slots; i++) {
        const d = slotDir(i);
        if (!lockHeld(d) && takeDir(d)) {
          if (lockHeld(XFLAG)) { dropDir(d); break; }    // an exclusive run started between our check and our take: yield to it
          return () => dropDir(d);
        }
      }
    }
    if (Date.now() - t0 > timeoutMs) throw timedOut();
    await sleep(pollMs);
  }
}

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch (_e) {}
}

class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.console = []; this.errors = []; this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message + ' (' + JSON.stringify(m.error.data || '') + ')')) : res(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.consoleAPICalled') {
          this.console.push({ type: m.params.type, text: m.params.args.map((a) => a.value !== undefined ? a.value : a.description || a.type).join(' ') });
        } else if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          this.errors.push((d.exception && d.exception.description) || d.text);
        } else if (m.method === 'Log.entryAdded') {
          if (m.params.entry.level === 'error') this.errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
        }
        for (const h of this.handlers) h(m);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async init() { await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Log.enable'); }
  async setViewport(width, height, { mobile = false, dpr = 1 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  async navigate(url, { waitMs = 15000 } = {}) {
    const loaded = new Promise((res) => { const h = (m) => { if (m.method === 'Page.loadEventFired') { this.handlers = this.handlers.filter((x) => x !== h); res(); } }; this.handlers.push(h); });
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(waitMs)]);
  }
  // Evaluate an expression in the page; awaits promises and returns the JSON-able value.
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expression, { timeoutMs = 30000, pollMs = 250 } = {}) {
    const t0 = Date.now();
    for (;;) {
      let v; try { v = await this.eval(expression); } catch (_e) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout: ' + expression);
      await sleep(pollMs);
    }
  }
  async screenshot(file, { fromSurface = true } = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async key(type, key, code, { windowsVirtualKeyCode } = {}) {
    await this.send('Input.dispatchKeyEvent', { type, key, code: code || key, windowsVirtualKeyCode });
  }
  async press(key, code, vk, holdMs = 40) { await this.key('keyDown', key, code, { windowsVirtualKeyCode: vk }); await sleep(holdMs); await this.key('keyUp', key, code, { windowsVirtualKeyCode: vk }); }
  async tap(x, y) {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  /**
   * A second tab in the SAME browser: same profile, so the same origin storage and the same BroadcastChannel. That is what a rig needs to pair two players
   * with lib/netplay.js's 'local' transport (net=local) without a network. The tab has the same viewport; it dies with the browser.
   */
  async openTab({ width, height, mobile = false } = {}) {
    const t = await getJson(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' });
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP websocket error (second tab)'))); });
    const tab = new Page(ws);
    tab.port = this.port;
    await tab.init();
    await tab.setViewport(width || this.width || 1280, height || this.height || 800, { mobile });
    return tab;
  }
}

/** What the page's own media queries say about the pointing device, and whether that is what the arm claims ('desktop' = hover:hover + pointer:fine; 'phone' = hover:none + pointer:coarse). */
export async function armFacts(page, claimed) {
  const media = await page.eval(`({ hoverHover: matchMedia('(hover: hover)').matches, hoverNone: matchMedia('(hover: none)').matches, ptrFine: matchMedia('(pointer: fine)').matches, ptrCoarse: matchMedia('(pointer: coarse)').matches, maxTouch: navigator.maxTouchPoints })`);
  const ok = claimed === 'desktop' ? media.hoverHover && media.ptrFine && !media.ptrCoarse : claimed === 'phone' ? media.hoverNone && media.ptrCoarse : true;
  return { claimed, ok, media };
}

export async function withBrowser(opts, fn) {
  const { port = 9222, width = 1280, height = 800, mobile = false, args = [], lock = true } = opts || {};
  if (!CHROME) throw new Error('chrome.exe not found; set CHROME_PATH');
  const release = lock ? await acquireBrowserLock() : () => {};
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bemental-chrome-'));
  let child = null, page = null;
  try {
    child = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      // --mute-audio: a test browser must NEVER reach the user's speakers/headphones (an emulator page that
      // starts an AudioContext otherwise plays through the default device even when headless).
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`,
      // A "desktop" arm must LOOK like a desktop: headless Chrome with no input devices reports hover:none and neither pointer:coarse nor fine (so every page that asks matchMedia took
      // a desktop for a touch screen). The desktop arms are launched as a machine with a mouse (hover:hover, pointer:fine); a phone arm (mobile:true) gets the touch emulation of
      // page.setViewport instead (coarse, hover:none). withBrowser checks below that the arm reports what it claims, and refuses (void) when it does not.
      ...(mobile || args.some((a) => /^--blink-settings=/.test(a)) ? [] : ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4']),
      ...args, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    try { require('./browser_leak_guard.js').guard({ process: () => child, on() {} }, 'headless_cdp'); } catch (_e) { /* guard is best-effort */ }
    let targets = null;
    for (let i = 0; i < 80 && !targets; i++) {
      try { targets = await getJson(`http://127.0.0.1:${port}/json/list`); } catch (_e) { await sleep(250); }
    }
    if (!targets) throw new Error('Chrome did not expose CDP on port ' + port);
    let t = targets.find((x) => x.type === 'page');
    if (!t) t = await getJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP websocket error'))); });
    page = new Page(ws);
    page.port = port; page.width = width; page.height = height;
    await page.init();
    await page.setViewport(width, height, { mobile });
    // the arm-difference proof: the arm must report what it claims, or no verdict is printed (a placebo arm is VOID, not a pass)
    page.arm = await armFacts(page, mobile ? 'phone' : 'desktop');
    if (!page.arm.ok) throw new Error('ARM VOID: the ' + page.arm.claimed + ' arm does not report what it claims: ' + JSON.stringify(page.arm.media));
    return await fn(page);
  } finally {
    try { page && page.ws.close(); } catch (_e) {}
    if (child) killTree(child.pid);
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_e) {}
    release();
  }
}
