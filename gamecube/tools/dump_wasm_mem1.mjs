#!/usr/bin/env node
// dump_wasm_mem1.mjs — boot the gamecube.html wasm probe far enough that
// MEM1 is wired into the SharedArrayBuffer, then dump four GUEST-MEM ranges
// matching the native dumps in /tmp/native-mem1-*.bin.
//
// Output:
//   /tmp/wasm-mem1-vectors.bin  (12800 B, guest 0x80000000..0x80003200)
//   /tmp/wasm-mem1-bs2.bin      ( 8960 B, guest 0x80003200..0x80005500)
//   /tmp/wasm-mem1-os.bin       (65536 B, guest 0x800e0000..0x800f0000)
//   /tmp/wasm-mem1-stack.bin    (131072 B, guest 0x803a0000..0x803c0000)
//
// MEM1 base in the SAB is read from SAB[0x02500020] (the address written
// by Dolphin's JitWasm::Run() entry, per gamecube.html:799-820 comment).
//
// Trigger policy:
//   - Wait until window._ppcMem1Wired === true AND we have observed at
//     least DUMP_MIN_WILD_PIVEC `[wild-pivec]` lines (default 5) so the
//     wasm halt corresponds to the SI-storm checkpoint (closest analog
//     to the native halt PC = 0x800eb058 SITransfer-class halt that
//     produced the native dumps; see gamecube/docs/native-oracle-complete-dump/TASKS.md
//     row 4b).
//   - If DUMP_AT_MS env is set, dump at that wall-clock time after Start
//     regardless of wild-pivec.
//   - Default timeout 60s, then dump whatever is in SAB.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = 8789;
const TIMEOUT_MS = parseInt(process.env.DUMP_TIMEOUT_MS || '90000', 10);
const MIN_WILD_PIVEC = parseInt(process.env.DUMP_MIN_WILD_PIVEC || '5', 10);
const DUMP_AT_MS = process.env.DUMP_AT_MS ? parseInt(process.env.DUMP_AT_MS, 10) : null;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const REGIONS = [
  { name: 'vectors', guestStart: 0x80000000, guestEnd: 0x80003200, expectedSize: 12800,
    out: '/tmp/wasm-mem1-vectors.bin' },
  { name: 'bs2',     guestStart: 0x80003200, guestEnd: 0x80005500, expectedSize: 8960,
    out: '/tmp/wasm-mem1-bs2.bin' },
  { name: 'os',      guestStart: 0x800e0000, guestEnd: 0x800f0000, expectedSize: 65536,
    out: '/tmp/wasm-mem1-os.bin' },
  { name: 'stack',   guestStart: 0x803a0000, guestEnd: 0x803c0000, expectedSize: 131072,
    out: '/tmp/wasm-mem1-stack.bin' },
];

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
  console.log(`[dump] server up on :${PORT}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
           `--js-flags=--max-old-space-size=4096 --no-liftoff`,
           '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
  });
  const page = await browser.newPage();

  let wildPivecCount = 0;
  let mem1Wired = false;
  let lastWildPivec = null;
  let lastSlice = null;

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[wild-pivec]')) {
      wildPivecCount++;
      lastWildPivec = t;
    }
    if (t.includes('MEM1 wired') || t.includes('ppc-worker MEM1 wired') || t.includes('dolphin ram')) {
      mem1Wired = true;
      console.log('[dump] ' + t);
    }
    if (t.includes('[slice]')) {
      lastSlice = t;
    }
  });
  page.on('pageerror', (err) => console.error('[dump] pageerror:', err.message || err));

  await page.setCacheEnabled(false);
  await page.goto(`http://127.0.0.1:${PORT}/gamecube.html?v=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1000));
  const romIdx = parseInt(process.env.ROM_IDX || '0', 10);
  await page.evaluate((idx) => {
    localStorage.setItem('gcwasm_romIdx', String(idx));
    const sel = document.getElementById('romSelect');
    if (sel) sel.value = String(idx);
  }, romIdx);
  console.log(`[dump] selected ROM index ${romIdx}`);

  await page.evaluate(() => { const b = document.getElementById('btnStart'); if (b) b.click(); });
  const startMs = Date.now();
  console.log(`[dump] Start clicked. Waiting for MEM1 wired + ${MIN_WILD_PIVEC} wild-pivec lines (or ${TIMEOUT_MS/1000}s timeout)`);

  // Poll for trigger.
  let triggered = false;
  let triggerReason = 'timeout';
  while (Date.now() - startMs < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 250));

    const m1 = await page.evaluate(() => !!window._ppcMem1Wired);

    if (DUMP_AT_MS != null && (Date.now() - startMs) >= DUMP_AT_MS && m1) {
      triggered = true; triggerReason = `wall=${Date.now()-startMs}ms`; break;
    }
    if (m1 && wildPivecCount >= MIN_WILD_PIVEC) {
      triggered = true; triggerReason = `mem1Wired+wildPivec=${wildPivecCount}`; break;
    }
  }
  if (!triggered) {
    triggerReason = `timeout: mem1Wired=${mem1Wired} wildPivec=${wildPivecCount}`;
  }
  console.log(`[dump] trigger: ${triggerReason} elapsed=${Date.now()-startMs}ms`);
  if (lastWildPivec) console.log(`[dump] last wild-pivec: ${lastWildPivec}`);
  if (lastSlice)     console.log(`[dump] last slice:      ${lastSlice}`);

  // Now read MEM1 base from SAB[0x02500020] AND dump each region.
  const dumpResult = await page.evaluate((regions) => {
    if (!window.sharedMemory || !window.sharedMemory.buffer) {
      return { ok: false, err: 'no window.sharedMemory.buffer' };
    }
    const sab = window.sharedMemory.buffer;
    const u32 = new Uint32Array(sab);
    const u8  = new Uint8Array(sab);
    const mem1Addr = u32[0x02500020 >> 2] >>> 0;
    const mem1Size = u32[0x02500024 >> 2] >>> 0;
    const sentinel = u32[0x02500028 >> 2] >>> 0;
    const result = { ok: true, mem1Addr, mem1Size, sentinel, regions: [] };
    for (const r of regions) {
      const guestOff = (r.guestStart - 0x80000000) >>> 0;
      const sabOff = (mem1Addr + guestOff) >>> 0;
      const size = (r.guestEnd - r.guestStart) >>> 0;
      // Copy bytes out as a regular Array<number> (no transfer needed —
      // we'll convert to Buffer Node-side).
      const slice = u8.subarray(sabOff, sabOff + size);
      const arr = Array.from(slice);
      result.regions.push({
        name: r.name, guestStart: r.guestStart, guestEnd: r.guestEnd,
        size, sabOff, bytes: arr,
      });
    }
    return result;
  }, REGIONS);

  if (!dumpResult.ok) {
    console.error('[dump] FAIL: ' + dumpResult.err);
    await browser.close(); srv.close(); process.exit(2);
  }

  console.log(`[dump] MEM1 SAB-offset addr=0x${dumpResult.mem1Addr.toString(16)} size=0x${dumpResult.mem1Size.toString(16)} sentinel=0x${dumpResult.sentinel.toString(16)}`);

  for (let i = 0; i < dumpResult.regions.length; ++i) {
    const r = dumpResult.regions[i];
    const buf = Buffer.from(r.bytes);
    fs.writeFileSync(REGIONS[i].out, buf);
    console.log(`[dump] wrote ${REGIONS[i].out} size=${buf.length} (expected ${REGIONS[i].expectedSize}) sabOff=0x${r.sabOff.toString(16)} guest=0x${r.guestStart.toString(16)}..0x${r.guestEnd.toString(16)}`);
    if (buf.length !== REGIONS[i].expectedSize) {
      console.error(`[dump] WARNING: size mismatch on ${r.name}`);
    }
  }

  // Best-effort: capture the current wedge PC so we can compare halt PCs.
  const wedgePc = await page.evaluate(() => {
    try {
      const u32 = new Uint32Array(window.sharedMemory.buffer);
      // PowerPCState.pc lives at PpcState base + 0xC4 (per dolphin layout);
      // the canonical PpcStateAddr we share with ppc-worker is 0x02400000.
      // Just sniff a few candidate offsets and return them all.
      const pc = u32[(0x02400000 + 0xC4) >> 2] >>> 0;
      const srr0 = u32[(0x02400000 + 0xCC) >> 2] >>> 0;
      const npc = u32[(0x02400000 + 0xC8) >> 2] >>> 0;
      return { pc, npc, srr0 };
    } catch (e) { return { err: String(e) }; }
  });
  console.log(`[dump] sniffed PpcState: ${JSON.stringify(wedgePc)}`);
  console.log(`[dump] wild-pivec count seen: ${wildPivecCount}`);

  await browser.close();
  srv.close();
  process.exit(0);
})().catch((err) => { console.error('[dump] error:', err); process.exit(2); });
