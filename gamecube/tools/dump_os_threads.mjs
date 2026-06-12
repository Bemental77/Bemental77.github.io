#!/usr/bin/env node
// dump_os_threads.mjs — boot gamecube.html, wait for wedge (or fixed time),
// then walk the guest OS thread state and print every thread, decoded.
//
// Mirrors dump_wasm_mem1.mjs in puppeteer setup. Reads MEM1 base from
// SAB[0x02500020]. Walks __OSActiveThreadQueue and prints each thread's
// state / priority / wait queue. Resolves thread struct addresses against
// the MP4 GMPE01_01 symbol map (override with --symbols).
//
// Struct offsets cited from ~/gc_refs/dolsdk2001/include/dolphin/os/OSThread.h
// and __OSThreadInit asm in marioparty4/build/GMPE01_01/asm/dolphin/os/OSThread.s.
//
// Lowmem slots (per dolsdk OSContext.c:8 + MP4 __OSThreadInit disasm):
//   0x800000D4  __OSCurrentContext  (OSContext*)
//   0x800000D8  __OSDefaultContext  (OSContext*, holds &DefaultThread.context)
//   0x800000DC  __OSActiveThreadQueue.head  (OSThread*)
//   0x800000E0  __OSActiveThreadQueue.tail  (OSThread*)
//   0x800000E4  __gCurrentThread           (OSThread*)
//
// MP4 GMPE01_01 specifics (from config/GMPE01_01/symbols.txt):
//   0x801A5418  RunQueue[32]   (32 × OSThreadQueue = 0x100)
//   0x801A5518  IdleThread     (OSThread, padded to 0x310)
//   0x801A5828  DefaultThread  (OSThread, padded to 0x310)
//
// OSThread offsets (sizeof = 0x30C; .bss alignment pads to 0x310):
//   0x000  OSContext   context  (0x2C8 bytes)
//   0x2C8  u16         state    (1=READY 2=RUNNING 4=WAITING 8=MORIBUND)
//   0x2CA  u16         attr     (bit 0 = DETACH)
//   0x2CC  s32         suspend
//   0x2D0  s32         priority (effective)
//   0x2D4  s32         base     (creation priority)
//   0x2D8  void*       val      (join return value / wake arg)
//   0x2DC  OSThreadQueue*  queue       (the queue this thread is on)
//   0x2E0  OSThread*   link.next
//   0x2E4  OSThread*   link.prev
//   0x2E8  OSThread*   queueJoin.head
//   0x2EC  OSThread*   queueJoin.tail
//   0x2F0  OSMutex*    mutex    (mutex this thread is blocked on, if any)
//   0x2F4  OSMutex*    queueMutex.head
//   0x2F8  OSMutex*    queueMutex.tail
//   0x2FC  OSThread*   linkActive.next   (used to walk __OSActiveThreadQueue)
//   0x300  OSThread*   linkActive.prev
//   0x304  u8*         stackBase
//   0x308  u32*        stackEnd
//
// Usage:
//   node gamecube/tools/dump_os_threads.mjs
//   ROM_IDX=0 OS_DUMP_AT_MS=120000 node gamecube/tools/dump_os_threads.mjs
//   node gamecube/tools/dump_os_threads.mjs --symbols /path/to/symbols.txt

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = 8790;
const TIMEOUT_MS = parseInt(process.env.OS_DUMP_TIMEOUT_MS || '180000', 10);
const DUMP_AT_MS = process.env.OS_DUMP_AT_MS ? parseInt(process.env.OS_DUMP_AT_MS, 10) : null;
const MIN_WEDGE_SAMPLES = parseInt(process.env.OS_DUMP_MIN_WEDGE || '4', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM_IDX = parseInt(process.env.ROM_IDX || '0', 10);

const SYMBOLS_DEFAULT = '/Users/caseybement/gc_refs/marioparty4/config/GMPE01_01/symbols.txt';
const SYMBOLS_PATH = (function() {
  const i = process.argv.indexOf('--symbols');
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return SYMBOLS_DEFAULT;
})();

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.bin': 'application/octet-stream', '.iso': 'application/octet-stream',
};

const STATE_NAMES = {
  1: 'READY',
  2: 'RUNNING',
  4: 'WAITING',
  8: 'MORIBUND',
};

// Lightweight symbols.txt parser. Returns { byAddr: Map<addr,name>, byName: Map }.
function loadSymbols(symPath) {
  const byAddr = new Map();
  const byName = new Map();
  if (!fs.existsSync(symPath)) {
    console.error(`[osdump] symbols file not found at ${symPath}; addresses will not be named`);
    return { byAddr, byName };
  }
  const text = fs.readFileSync(symPath, 'utf8');
  // Lines look like:
  //   SelectThread = .text:0x800BA1B8; // type:function size:0x200 scope:local
  const re = /^\s*([A-Za-z_][\w@.]*)\s*=\s*\.[A-Za-z0-9_.]+:0x([0-9A-Fa-f]+);/;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const name = m[1];
    const addr = parseInt(m[2], 16) >>> 0;
    byAddr.set(addr, name);
    byName.set(name, addr);
  }
  return { byAddr, byName };
}

// Find the nearest symbol at-or-below a given address. Returns
// `name+offset` style for clarity.
function resolveAddr(syms, addr) {
  if (addr === 0) return '(null)';
  // Exact hit first.
  if (syms.byAddr.has(addr)) return syms.byAddr.get(addr);
  // Otherwise, scan for the largest addr <= target. The map isn't sorted —
  // for correctness over speed, build a sorted array once and cache it.
  if (!syms._sorted) {
    syms._sorted = Array.from(syms.byAddr.keys()).sort((a, b) => a - b);
  }
  const arr = syms._sorted;
  // Binary search for largest arr[i] <= addr.
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= addr) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best < 0) return `0x${addr.toString(16)}`;
  const base = arr[best];
  const off = addr - base;
  if (off === 0) return syms.byAddr.get(base);
  return `${syms.byAddr.get(base)}+0x${off.toString(16)}`;
}

// RunQueue[32] occupies 0x801A5418..0x801A5518 (32 × 8 bytes).
// Given a queue pointer, return its label.
function describeQueue(qptr, syms, runQueueBase) {
  if (qptr === 0) return '(null)';
  if (qptr >= runQueueBase && qptr < runQueueBase + 0x100) {
    const idx = (qptr - runQueueBase) >>> 3;
    return `RunQueue[${idx}] @ 0x${qptr.toString(16)}`;
  }
  return resolveAddr(syms, qptr) + ` @ 0x${qptr.toString(16)}`;
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/gamecube.html';
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
  const syms = loadSymbols(SYMBOLS_PATH);
  console.log(`[osdump] symbols loaded: ${syms.byAddr.size} from ${SYMBOLS_PATH}`);

  const srv = await startServer();
  console.log(`[osdump] server up on :${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
           '--js-flags=--max-old-space-size=4096 --no-liftoff',
           '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
  });
  const page = await browser.newPage();

  let wedgeSamples = 0;
  let mem1Wired = false;
  let lastPcSample = null;

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('MEM1 wired') || t.includes('ppc-worker MEM1 wired') || t.includes('dolphin ram')) {
      if (!mem1Wired) console.log('[osdump] ' + t);
      mem1Wired = true;
    }
    // Wedge signals — any of these counts as "interesting":
    //  - ax-ee CheckExternalExceptions at the SelectThread spin PC repeatedly
    //  - dsp-sentinel repeats
    //  - wild-idle-detected
    //  - mp4-wedge-diag IRQ-raise crossing 50K
    if (t.includes('pc=0x800ba2f0') && t.includes('ax-ee')) {
      wedgeSamples++;
      lastPcSample = t;
    }
    if (t.includes('[wild-idle-detected]') || t.includes('[dsp-sentinel]')) {
      wedgeSamples++;
    }
  });
  page.on('pageerror', (err) => console.error('[osdump] pageerror:', err.message || err));

  await page.setCacheEnabled(false);
  await page.goto(`http://127.0.0.1:${PORT}/gamecube.html?v=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1000));
  await page.evaluate((idx) => {
    localStorage.setItem('gcwasm_romIdx', String(idx));
    const sel = document.getElementById('romSelect');
    if (sel) sel.value = String(idx);
  }, ROM_IDX);
  console.log(`[osdump] selected ROM index ${ROM_IDX}`);

  await page.evaluate(() => { const b = document.getElementById('btnStart'); if (b) b.click(); });
  const startMs = Date.now();
  console.log(`[osdump] Start clicked. Waiting for ${DUMP_AT_MS != null ? `OS_DUMP_AT_MS=${DUMP_AT_MS}` : `MEM1 ram-info reply + ${MIN_WEDGE_SAMPLES} wedge samples`} (timeout ${TIMEOUT_MS}ms)`);

  // The dolphin-src.bak used to publish MEM1 base to SAB[0x02500020/24/28]
  // automatically; the current dolphin-src does NOT (re-extracted 2026-05-29).
  // We drive `get-ram-info` ourselves and capture the reply via a one-shot
  // listener installed inside the poll loop (window.dolphin_worker isn't
  // created until var_setup() runs, well after page load).
  await page.evaluate(() => {
    window._osdumpRamAddr = 0;
    window._osdumpRamSize = 0;
    window._osdumpListenerInstalled = false;
  });

  let triggered = false;
  let triggerReason = 'timeout';
  let lastGetRamReq = 0;
  // Don't start polling get-ram-info until the page has clearly progressed
  // past worker runtime init. Posting it too early fires the Emscripten
  // ASSERTIONS=1 wrapper ("native function called before runtime
  // initialization") in a tight loop because case 'get-ram-info' isn't
  // gated by Module.calledRun. We use 25s wall-clock (boot reaches
  // VI_FIELD_BELOW around 25-30s in current builds per recent probes) as
  // a coarse but reliable gate.
  const GET_RAM_GATE_MS = 25000;
  while (Date.now() - startMs < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 250));
    if (Date.now() - startMs > GET_RAM_GATE_MS && Date.now() - lastGetRamReq > 500) {
      await page.evaluate(() => {
        if (!window.dolphin_worker) return;
        // Install our reply listener the first time dolphin_worker exists.
        if (!window._osdumpListenerInstalled) {
          window._osdumpReplyCount = 0;
          window._osdumpRamInfoSeen = 0;
          window._osdumpLastCmds = [];
          window.dolphin_worker.addEventListener('message', function (e) {
            try {
              if (!e || !e.data) return;
              window._osdumpReplyCount++;
              if (e.data.cmd) {
                window._osdumpLastCmds.push(e.data.cmd);
                if (window._osdumpLastCmds.length > 50) window._osdumpLastCmds.shift();
              }
              if (e.data.cmd === 'ram-info') {
                window._osdumpRamInfoSeen++;
                if ((e.data.addr >>> 0) !== 0) {
                  window._osdumpRamAddr = e.data.addr >>> 0;
                  window._osdumpRamSize = e.data.size >>> 0;
                }
              }
            } catch (err) {}
          });
          window._osdumpListenerInstalled = true;
        }
        if (!window._osdumpRamAddr) {
          try { window.dolphin_worker.postMessage({ cmd: 'get-ram-info' }); } catch (e) {}
        }
      });
      lastGetRamReq = Date.now();
    }
    const ramState = await page.evaluate(() => ({
      addr: window._osdumpRamAddr >>> 0,
      size: window._osdumpRamSize >>> 0,
    }));
    const haveMem1 = ramState.addr !== 0;
    if (haveMem1 && !mem1Wired) {
      mem1Wired = true;
      console.log(`[osdump] MEM1 ram-info received: addr=0x${ramState.addr.toString(16)} size=0x${ramState.size.toString(16)}`);
    }
    if (DUMP_AT_MS != null && (Date.now() - startMs) >= DUMP_AT_MS) {
      triggered = true; triggerReason = `OS_DUMP_AT_MS hit (wall=${Date.now()-startMs}ms, ramInfoReceived=${haveMem1})`; break;
    }
    if (DUMP_AT_MS == null && wedgeSamples >= MIN_WEDGE_SAMPLES) {
      triggered = true; triggerReason = `wedgeSamples=${wedgeSamples} (ramInfoReceived=${haveMem1})`; break;
    }
  }
  if (!triggered) {
    triggerReason = `timeout: mem1Wired=${mem1Wired} wedgeSamples=${wedgeSamples}`;
  }
  console.log(`[osdump] trigger: ${triggerReason} elapsed=${Date.now()-startMs}ms`);
  if (lastPcSample) console.log(`[osdump] last spin sample: ${lastPcSample.slice(0, 220)}`);

  // Diag: report what the listener saw, so failure mode is visible.
  const diag = await page.evaluate(() => ({
    replyCount: window._osdumpReplyCount || 0,
    ramInfoSeen: window._osdumpRamInfoSeen || 0,
    lastCmds: (window._osdumpLastCmds || []).slice(-20),
    dolphinWorkerExists: !!window.dolphin_worker,
    listenerInstalled: !!window._osdumpListenerInstalled,
  }));
  console.log(`[osdump] reply-listener diag: replyCount=${diag.replyCount} ramInfoSeen=${diag.ramInfoSeen} dolphinWorker=${diag.dolphinWorkerExists} listenerInstalled=${diag.listenerInstalled}`);
  console.log(`[osdump] last ${diag.lastCmds.length} dolphin_worker cmds: ${JSON.stringify(diag.lastCmds)}`);

  // Walk the OS thread state inside one page.evaluate so we don't need
  // many round-trips. Returns:
  //   { ok, mem1Addr, current, activeHead, activeTail, runQueue, threads: [...] }
  // Each thread:
  //   { addr, state, attr, suspend, priority, base, val, queue,
  //     link_next, link_prev, queueJoin_head, queueJoin_tail, mutex,
  //     queueMutex_head, queueMutex_tail, linkActive_next, linkActive_prev,
  //     stackBase, stackEnd }
  const walkResult = await page.evaluate(() => {
    if (!window.sharedMemory || !window.sharedMemory.buffer) {
      return { ok: false, err: 'no window.sharedMemory.buffer' };
    }
    const sab = window.sharedMemory.buffer;
    const u32 = new Uint32Array(sab);
    const u8  = new Uint8Array(sab);
    // Discover MEM1 base inside the SAB. Three fallbacks in priority order:
    //   1. window._osdumpRamAddr if get-ram-info ever replied (new bridge).
    //   2. u32[0x02500020 >> 2] (old dolphin-src.bak sentinel; deprecated).
    //   3. Direct scan: find the GameID 'GMPE01' byte sequence (placed by
    //      BS2/DVD header copy at MEM1[0]). The first matching offset is
    //      mem1Addr. Boot must have run far enough for the DVD header to
    //      land — VI_FIELD_BELOW is well past that point.
    let mem1Addr = (window._osdumpRamAddr >>> 0) || (u32[0x02500020 >> 2] >>> 0);
    let mem1Source = mem1Addr !== 0 ? 'get-ram-info' : '';
    if (mem1Addr === 0) {
      // Two-part signature:
      //   GMPE01 = 47 4D 50 45 30 31 at offset 0x00 (disc gameID).
      //   0xC2339F3D (BE) at offset 0x1C (GameCube disc boot magic).
      // Both must match. The combined signature is collision-unique vs
      // random Dolphin string literals (which produce GMPE01 hits inside
      // overrides tables but lack the magic word at offset +0x1C).
      const sig = [0x47, 0x4D, 0x50, 0x45, 0x30, 0x31];
      const limit = sab.byteLength - 0x20;
      for (let off = 0; off < limit; off += 4) {
        if (u8[off]   !== sig[0] || u8[off+1] !== sig[1] ||
            u8[off+2] !== sig[2] || u8[off+3] !== sig[3] ||
            u8[off+4] !== sig[4] || u8[off+5] !== sig[5]) continue;
        // Magic at +0x1C should be 0xC2 0x33 0x9F 0x3D (big-endian).
        if (u8[off+0x1C] !== 0xC2 || u8[off+0x1D] !== 0x33 ||
            u8[off+0x1E] !== 0x9F || u8[off+0x1F] !== 0x3D) continue;
        mem1Addr = off >>> 0;
        mem1Source = `signature-scan @ 0x${off.toString(16)} (GMPE01+magic)`;
        break;
      }
    }
    if (mem1Addr === 0) return { ok: false, err: 'mem1Addr=0 (get-ram-info silent, signature-scan found no GMPE01+magic)' };
    // Guest 0x800000HH → SAB byte off `mem1Addr + 0xHH`. Words are guest
    // big-endian; the SAB layout is byte-identical to MEM1 (the JIT and
    // the host runtime both treat it as the guest physical RAM), so we
    // must read big-endian for any multi-byte field.
    const guestRead32 = (gaddr) => {
      const off = ((gaddr - 0x80000000) >>> 0) + mem1Addr;
      // Big-endian u32 reconstruct
      return ((u8[off] << 24) | (u8[off+1] << 16) | (u8[off+2] << 8) | u8[off+3]) >>> 0;
    };
    const guestRead16 = (gaddr) => {
      const off = ((gaddr - 0x80000000) >>> 0) + mem1Addr;
      return ((u8[off] << 8) | u8[off+1]) >>> 0;
    };

    const lowmem = {
      OSCurrentContext: guestRead32(0x800000D4),
      OSDefaultContext: guestRead32(0x800000D8),
      ActiveQueueHead:  guestRead32(0x800000DC),
      ActiveQueueTail:  guestRead32(0x800000E0),
      gCurrentThread:   guestRead32(0x800000E4),
      OSMask:           guestRead32(0x800000C4),
      OSUserMask:       guestRead32(0x800000C8),
    };

    const RUNQUEUE_BASE = 0x801A5418;
    const runQueue = [];
    for (let i = 0; i < 32; ++i) {
      const head = guestRead32(RUNQUEUE_BASE + i * 8);
      const tail = guestRead32(RUNQUEUE_BASE + i * 8 + 4);
      runQueue.push({ prio: i, head, tail });
    }

    // Read one OSThread struct at gaddr.
    const readThread = (gaddr) => {
      if (gaddr === 0) return null;
      // Quick sanity: must be in MEM1.
      if (gaddr < 0x80000000 || gaddr >= 0x81800000) {
        return { addr: gaddr, error: 'out_of_range' };
      }
      return {
        addr: gaddr,
        state:           guestRead16(gaddr + 0x2C8),
        attr:            guestRead16(gaddr + 0x2CA),
        suspend:         guestRead32(gaddr + 0x2CC) | 0,
        priority:        guestRead32(gaddr + 0x2D0) | 0,
        base:            guestRead32(gaddr + 0x2D4) | 0,
        val:             guestRead32(gaddr + 0x2D8),
        queue:           guestRead32(gaddr + 0x2DC),
        link_next:       guestRead32(gaddr + 0x2E0),
        link_prev:       guestRead32(gaddr + 0x2E4),
        queueJoin_head:  guestRead32(gaddr + 0x2E8),
        queueJoin_tail:  guestRead32(gaddr + 0x2EC),
        mutex:           guestRead32(gaddr + 0x2F0),
        queueMutex_head: guestRead32(gaddr + 0x2F4),
        queueMutex_tail: guestRead32(gaddr + 0x2F8),
        linkActive_next: guestRead32(gaddr + 0x2FC),
        linkActive_prev: guestRead32(gaddr + 0x300),
        stackBase:       guestRead32(gaddr + 0x304),
        stackEnd:        guestRead32(gaddr + 0x308),
      };
    };

    // Walk __OSActiveThreadQueue from head via linkActive.next.
    // Bounded at 64 iterations as a safety; if MP4 has more threads we'll
    // bump it. Also guards against cycles.
    const seen = new Set();
    const threads = [];
    let cur = lowmem.ActiveQueueHead;
    let iters = 0;
    while (cur && iters < 64) {
      if (seen.has(cur)) {
        threads.push({ addr: cur, error: 'cycle_detected' });
        break;
      }
      seen.add(cur);
      const t = readThread(cur);
      if (!t || t.error) { threads.push(t || { addr: cur, error: 'null_read' }); break; }
      threads.push(t);
      cur = t.linkActive_next >>> 0;
      iters++;
    }

    // Also force-read the two known statically-allocated threads, in case
    // the active queue walk missed them (corruption / mid-init state).
    const STATIC_THREADS = [
      { name: 'IdleThread',    addr: 0x801A5518 },
      { name: 'DefaultThread', addr: 0x801A5828 },
    ];
    const staticReads = STATIC_THREADS.map(s => ({ name: s.name, t: readThread(s.addr) }));

    return {
      ok: true,
      mem1Addr,
      mem1Source,
      lowmem,
      runQueue,
      threads,
      staticReads,
    };
  });

  if (!walkResult.ok) {
    console.error(`[osdump] FAIL: ${walkResult.err}`);
    await browser.close(); srv.close(); process.exit(2);
  }

  // ---- Print ------------------------------------------------------------

  const RUNQUEUE_BASE = 0x801A5418;

  console.log('');
  console.log(`=== MEM1 base discovered: SAB offset 0x${walkResult.mem1Addr.toString(16)} via ${walkResult.mem1Source} ===`);
  console.log('');
  console.log('=== Lowmem OS slots ===');
  const lm = walkResult.lowmem;
  console.log(`  __OSCurrentContext     0x800000D4 = 0x${lm.OSCurrentContext.toString(16)} (${resolveAddr(syms, lm.OSCurrentContext)})`);
  console.log(`  __OSDefaultContext     0x800000D8 = 0x${lm.OSDefaultContext.toString(16)} (${resolveAddr(syms, lm.OSDefaultContext)})`);
  console.log(`  __OSActiveQueue.head   0x800000DC = 0x${lm.ActiveQueueHead.toString(16)} (${resolveAddr(syms, lm.ActiveQueueHead)})`);
  console.log(`  __OSActiveQueue.tail   0x800000E0 = 0x${lm.ActiveQueueTail.toString(16)} (${resolveAddr(syms, lm.ActiveQueueTail)})`);
  console.log(`  __gCurrentThread       0x800000E4 = 0x${lm.gCurrentThread.toString(16)} (${resolveAddr(syms, lm.gCurrentThread)})`);
  console.log(`  __OSMask (0xC4)        = 0x${lm.OSMask.toString(16)}`);
  console.log(`  __OSUserMask (0xC8)    = 0x${lm.OSUserMask.toString(16)}`);

  console.log('');
  console.log('=== Active thread queue (walk from head via linkActive.next) ===');
  if (walkResult.threads.length === 0) {
    console.log('  (queue empty)');
  } else {
    for (const t of walkResult.threads) {
      if (t.error) { console.log(`  0x${t.addr.toString(16)}: ERR ${t.error}`); continue; }
      const stateName = STATE_NAMES[t.state] || `?${t.state}`;
      const nameLabel = resolveAddr(syms, t.addr);
      const isCurrent = t.addr === lm.gCurrentThread ? '  <-- CURRENT' : '';
      console.log(`  ${nameLabel} (0x${t.addr.toString(16)}) state=${stateName}(${t.state}) prio=${t.priority} base=${t.base} suspend=${t.suspend}${isCurrent}`);
      console.log(`    queue       = ${describeQueue(t.queue, syms, RUNQUEUE_BASE)}`);
      console.log(`    val         = 0x${t.val.toString(16)}`);
      console.log(`    link        next=0x${t.link_next.toString(16)} prev=0x${t.link_prev.toString(16)}`);
      console.log(`    linkActive  next=0x${t.linkActive_next.toString(16)} prev=0x${t.linkActive_prev.toString(16)}`);
      console.log(`    queueJoin   head=0x${t.queueJoin_head.toString(16)} tail=0x${t.queueJoin_tail.toString(16)}`);
      console.log(`    mutex       = 0x${t.mutex.toString(16)}  queueMutex head=0x${t.queueMutex_head.toString(16)} tail=0x${t.queueMutex_tail.toString(16)}`);
      console.log(`    stack       base=0x${t.stackBase.toString(16)} end=0x${t.stackEnd.toString(16)}`);
    }
  }

  console.log('');
  console.log('=== Static thread instances (force-read regardless of queue walk) ===');
  for (const s of walkResult.staticReads) {
    const t = s.t;
    if (!t || t.error) { console.log(`  ${s.name} 0x${s.t?.addr?.toString(16) ?? '?'}: ERR ${t?.error ?? 'null'}`); continue; }
    const stateName = STATE_NAMES[t.state] || `?${t.state}`;
    console.log(`  ${s.name} @ 0x${t.addr.toString(16)}: state=${stateName}(${t.state}) prio=${t.priority} base=${t.base} suspend=${t.suspend}`);
    console.log(`    queue=${describeQueue(t.queue, syms, RUNQUEUE_BASE)}  linkActive next=0x${t.linkActive_next.toString(16)} prev=0x${t.linkActive_prev.toString(16)}`);
  }

  console.log('');
  console.log('=== RunQueue[32] occupancy (head != 0) ===');
  let runQueueAnyOccupied = false;
  for (const q of walkResult.runQueue) {
    if (q.head === 0 && q.tail === 0) continue;
    runQueueAnyOccupied = true;
    console.log(`  RunQueue[${q.prio.toString().padStart(2, ' ')}] head=0x${q.head.toString(16).padStart(8, '0')} tail=0x${q.tail.toString(16).padStart(8, '0')}  (${resolveAddr(syms, q.head)})`);
  }
  if (!runQueueAnyOccupied) {
    console.log('  (all RunQueue priorities empty — no thread is RUNNABLE; this matches a SelectThread idle spin)');
  }

  console.log('');
  console.log('=== Summary ===');
  const runnable = walkResult.threads.filter(t => !t.error && t.state === 1);
  const running  = walkResult.threads.filter(t => !t.error && t.state === 2);
  const waiting  = walkResult.threads.filter(t => !t.error && t.state === 4);
  const moribund = walkResult.threads.filter(t => !t.error && t.state === 8);
  console.log(`  Total active: ${walkResult.threads.length}`);
  console.log(`  READY:    ${runnable.length}`);
  console.log(`  RUNNING:  ${running.length}`);
  console.log(`  WAITING:  ${waiting.length}`);
  console.log(`  MORIBUND: ${moribund.length}`);
  if (waiting.length > 0) {
    console.log('');
    console.log('  WAITING threads (each blocked on some OSThreadQueue — check the queue addr):');
    for (const t of waiting) {
      console.log(`    ${resolveAddr(syms, t.addr)} (0x${t.addr.toString(16)}) -> waiting on ${describeQueue(t.queue, syms, RUNQUEUE_BASE)}`);
    }
  }

  await browser.close();
  srv.close();
  process.exit(0);
})().catch((err) => { console.error('[osdump] error:', err); process.exit(2); });
