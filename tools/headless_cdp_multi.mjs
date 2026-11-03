// tools/headless_cdp_multi.mjs - N pages in ONE headless Chrome, over bare CDP (no puppeteer), for tests of a multi-player ROOM.
//
// WHY ONE BROWSER, N WINDOWS. lib/netplay.js `?net=local` signalling is a BroadcastChannel on one origin in one browser: two processes
// cannot see each other on it, and two TABS of one window are not enough either - Chrome gives a HIDDEN tab no requestAnimationFrame and
// the emulator pages are driven from rAF, so the background tab would run zero frames and the room would stall on a console frozen by
// the HARNESS (tools/genesis_netplay_test.mjs documents the measurement). Each peer therefore gets its OWN WINDOW (Target.createTarget
// {newWindow: true}); every window reports visibilityState "visible". All of them share one profile, which is also what `local`
// signalling needs.
//
//   import { withBrowserMulti } from './headless_cdp_multi.mjs';
//   await withBrowserMulti({ port: 9251, windows: 2, width: 900, height: 700 }, async ({ pages, openWindow, closeWindow }) => {
//     await Promise.all(pages.map((p) => p.navigate('http://localhost:8092/gba.html?net=local')));
//   });
//
// * It is a thin layer over tools/headless_cdp.mjs withBrowser(), so everything that file guarantees is inherited and NOT re-implemented:
//   the machine-wide browser lock (ONE browser at a time on this box - a second caller queues), `--mute-audio` (a test browser must never
//   reach the user's headphones), a throwaway profile, registration with tools/browser_leak_guard.js, process-tree kill on exit.
// * Extra flags only keep every window painting and timing at full rate: no background throttling, no occlusion detection.
// * Each page gets focus emulation, so a window stacked behind another is still "focused" for the page's own purposes.
import { withBrowser, acquireBrowserLock } from './headless_cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const KEEP_ALIVE_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
];

async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!r.ok) throw new Error('json/list -> HTTP ' + r.status);
  return r.json();
}

/**
 * Launch one headless Chrome, give `windows` pages (each in its own window) to `fn`.
 *   opts: { port = 9251, windows = 2, width = 900, height = 700, mobile = false, args = [], lock = true }
 *   fn({ pages, openWindow(opts?) -> Page, closeWindow(page) -> void, port, browserInfo })
 * Pages are the same `Page` objects headless_cdp.mjs hands out (eval, waitFor, navigate, screenshot, key, press, tap, click, console, errors).
 */
export async function withBrowserMulti(opts, fn) {
  const o = opts || {};
  const port = o.port || 9251, n = Math.max(1, o.windows || 2), width = o.width || 900, height = o.height || 700;
  // Queue patiently: other agents' rigs hold the same machine-wide lock for many minutes (the default 15-minute wait of withBrowser() timed a queued
  // run out). The lock is taken HERE, with a long timeout, and handed to nobody else: withBrowser() is told lock:false and the release is in the finally.
  const release = o.lock !== false ? await acquireBrowserLock({ timeoutMs: o.lockTimeoutMs || 4 * 3600 * 1000, pollMs: o.lockPollMs || 500 }) : () => {};
  try {
  return await withBrowser({ port, width, height, mobile: !!o.mobile, lock: false, args: [...KEEP_ALIVE_FLAGS, ...(o.args || [])] }, async (page0) => {
    const Page = page0.constructor;
    const opened = [page0];
    const known = new Set();
    // The first page's own target id, so a later createTarget is recognised by difference.
    for (const t of await listTargets(port)) known.add(t.id);

    async function prepare(p, w, h, mobile) {
      await p.init();
      await p.setViewport(w, h, { mobile: !!mobile });
      // A window stacked behind another must still be treated as focused and visible by the page.
      try { await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_e) { /* older Chrome */ }
      try { await p.send('Page.bringToFront'); } catch (_e) { /* best effort */ }
      return p;
    }
    async function openWindow(wo) {
      const w = (wo && wo.width) || width, h = (wo && wo.height) || height;
      const r = await page0.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: w, height: h });
      const id = r.targetId;
      let t = null;
      for (let i = 0; i < 80 && !t; i++) {
        t = (await listTargets(port)).find((x) => x.id === id);
        if (!t) await sleep(100);
      }
      if (!t) throw new Error('the new window never appeared in /json/list');
      known.add(id);
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP websocket error'))); });
      const p = new Page(ws);
      p.targetId = id;
      // a window opened without options is a window of the SAME kind as the first (opts.mobile), not a desktop one: GBA_NETPLAY_PHONE=1 used to make
      // only window 0 a phone because this call dropped the flag
      await prepare(p, w, h, wo && wo.mobile !== undefined ? wo.mobile : o.mobile);
      opened.push(p);
      return p;
    }
    async function closeWindow(p) {
      const id = p.targetId;
      try { if (id) await page0.send('Target.closeTarget', { targetId: id }); } catch (_e) { /* already gone */ }
      try { p.ws.close(); } catch (_e) { /* ignore */ }
      const i = opened.indexOf(p); if (i >= 0) opened.splice(i, 1);
    }
    // page0 is the browser's first window; its target id is the one /json/list lists as a page that is not ours.
    page0.targetId = (await listTargets(port)).find((t) => t.type === 'page') ? (await listTargets(port)).find((t) => t.type === 'page').id : null;
    await prepare(page0, width, height, !!o.mobile);
    const pages = [page0];
    for (let i = 1; i < n; i++) pages.push(await openWindow());
    let info = null;
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (_e) { /* informational */ }
    return fn({ pages, openWindow, closeWindow, port, browserInfo: info });
  });
  } finally { release(); }
}
