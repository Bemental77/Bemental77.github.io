#!/usr/bin/env node
// diagnose_gc.mjs — RAW probe of gamecube.html. No filtering, no buckets.
// Captures every console event, page error, network failure, and request
// that comes through, then waits while the user-driven flow runs.
//
// Usage:
//   node gamecube/tools/diagnose_gc.mjs           # observe page load only (no Start click)
//   node gamecube/tools/diagnose_gc.mjs run       # also click Start, observe ROM load + boot
//   ROM_IDX=1 node gamecube/tools/diagnose_gc.mjs run   # use PSO

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = 8790;
const DURATION_MS = parseInt(process.env.DIAG_DURATION_MS || '30000', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CLICK_START = process.argv.includes('run');
const ROM_IDX = parseInt(process.env.ROM_IDX || '0', 10);

const MIME = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.wasm': 'application/wasm', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png',
    '.bin': 'application/octet-stream', '.iso': 'application/octet-stream',
};

function startServer() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            res.setHeader('Cross-Origin-Opener-Policy',  'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            let urlPath = decodeURIComponent(req.url.split('?')[0]);
            if (urlPath === '/') urlPath = '/gamecube.html';
            const filePath = path.join(ROOT, urlPath);
            fs.stat(filePath, (err, stat) => {
                if (err) {
                    console.log(`[404] ${urlPath}`);
                    res.statusCode = 404; res.end('404'); return;
                }
                const ext = path.extname(filePath).toLowerCase();
                res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
                res.setHeader('Content-Length', stat.size);
                fs.createReadStream(filePath).pipe(res);
            });
        });
        srv.listen(PORT, '127.0.0.1', () => resolve(srv));
    });
}

(async () => {
    const srv = await startServer();
    console.log(`[diag] server up on :${PORT}`);
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-dev-shm-usage'],
        protocolTimeout: DURATION_MS + 60000,
    });
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

    const page = await browser.newPage();

    // Print everything, no buckets, no filtering.
    page.on('console', (msg) => {
        const t = msg.text();
        const type = msg.type();
        console.log(`[${type}] ${t}`);
    });
    page.on('pageerror', (err) => {
        console.log(`[pageerror] ${err.message}\n${err.stack || ''}`);
    });
    page.on('requestfailed', (req) => {
        console.log(`[reqfail] ${req.url()} → ${req.failure() && req.failure().errorText}`);
    });
    page.on('response', (res) => {
        const status = res.status();
        if (status >= 400) {
            console.log(`[http ${status}] ${res.url()}`);
        }
    });

    console.log(`[diag] navigating to http://127.0.0.1:${PORT}/gamecube.html`);
    await page.goto(`http://127.0.0.1:${PORT}/gamecube.html`, { waitUntil: 'load', timeout: 60000 });
    console.log(`[diag] page loaded`);

    if (CLICK_START) {
        await new Promise(r => setTimeout(r, 1000));
        await page.evaluate((idx) => {
            localStorage.setItem('gcwasm_romIdx', String(idx));
            const sel = document.getElementById('romSelect');
            if (sel) sel.value = String(idx);
        }, ROM_IDX);
        console.log(`[diag] selected ROM index ${ROM_IDX}`);
        const clicked = await page.evaluate(() => {
            const b = document.getElementById('btnStart');
            if (!b) return false;
            b.click();
            return true;
        });
        console.log(`[diag] btnStart click=${clicked}`);
    } else {
        console.log(`[diag] (no Start click — pass 'run' to click)`);
    }

    console.log(`[diag] observing for ${DURATION_MS}ms ...`);
    await new Promise(r => setTimeout(r, DURATION_MS));

    // Dump page state at the end.
    const finalState = await page.evaluate(() => {
        const status = document.getElementById('status');
        const fps    = document.getElementById('fps');
        const log    = document.getElementById('log');
        return {
            status: status ? status.textContent : null,
            fps:    fps ? fps.textContent : null,
            logTail: log ? log.textContent.split('\n').slice(-20).join('\n') : null,
            hasWorker: typeof window.dolphin_worker !== 'undefined',
            hasModule: typeof window.Module !== 'undefined',
            moduleReady: typeof window.Module !== 'undefined' && !!window.Module.calledRun,
        };
    });
    console.log('---FINAL STATE---');
    console.log(JSON.stringify(finalState, null, 2));

    // Screenshot the canvas — this reads the actual GPU-rendered pixels
    // including offscreen-transferred canvases, unlike getImageData.
    const shotPath = process.env.DIAG_SHOT_PATH || '/tmp/gamecube-shot.png';
    try {
        const canvas = await page.$('#canvas');
        if (canvas) {
            await canvas.screenshot({ path: shotPath });
            console.log(`[diag] canvas screenshot → ${shotPath}`);
        } else {
            console.log('[diag] no #canvas element found');
        }
    } catch (e) {
        console.log(`[diag] screenshot failed: ${e.message}`);
    }

    await browser.close();
    srv.close();
})().catch(e => { console.error('diag error:', e); process.exit(1); });
