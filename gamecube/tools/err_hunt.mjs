// err_hunt.mjs — load gamecube.html and print EVERY error-class signal:
// console.error messages, pageerrors, failed/4xx-5xx requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = 8091;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm' };
const srv = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; res.end('404'); return; }
    res.setHeader('Content-Type', MIME[path.extname(p).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
  });
});
srv.listen(PORT, '127.0.0.1', async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      console.log(`[console.${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log('[pageerror] ' + String(e).slice(0, 300)));
  page.on('requestfailed', (r) =>
    console.log(`[requestfailed] ${r.url().slice(0, 160)} — ${r.failure() && r.failure().errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url().slice(0, 160)}`);
  });
  await page.goto(`http://127.0.0.1:${PORT}/gamecube.html`, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 20000));
  await browser.close();
  srv.close();
  console.log('[err-hunt] done');
});
