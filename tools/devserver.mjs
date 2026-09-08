#!/usr/bin/env node
// The local dev server, with the one behaviour python3 -m http.server lacks:
// HTTP RANGE.
//
// WHY THIS EXISTS. `npm run web` was `python3 -m http.server 8080`, and it
// answers a Range request with the WHOLE FILE:
//   $ curl -D- -H 'Range: bytes=0-1023' http://localhost:8080/<a disc track>
//   HTTP/1.0 200 OK
//   Server: SimpleHTTP/0.6 Python/3.14.5
// while production answers correctly:
//   $ curl -D- -H 'Range: bytes=0-1023' https://caseybement.com/<the same track>
//   HTTP/2 206
//   content-range: bytes 0-1023/1999200
// Two consequences, both of which have cost real work:
//   1. THE RANGE-STREAMING DISC PATH HAS NEVER BEEN EXERCISED LOCALLY. Every
//      local run silently takes the eager path, so a local pass proves nothing
//      about the feature, and a regression in it cannot be caught here.
//   2. EVERY LOCAL EMULATOR INSTANCE FETCHES A WHOLE DISC. Several rigs running
//      at once each pulled hundreds of MB, and mutual starvation showed up as
//      `disc-fetch 0%` and identical boot timeouts that read like emulator
//      faults rather than a server limitation.
// This is deliberately the smallest thing that fixes that: static files, Range,
// conditional requests, and nothing else. `npm run web:simple` keeps the old
// python server for comparison if this is ever suspected.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.WEB_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip', '.cue': 'text/plain', '.bin': 'application/octet-stream',
  '.z64': 'application/octet-stream', '.n64': 'application/octet-stream',
  '.iso': 'application/octet-stream', '.cdi': 'application/octet-stream',
  '.state': 'application/octet-stream', '.sav': 'application/octet-stream',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// Resolve inside ROOT only. A traversal must 403 rather than read the disk.
function resolveSafe(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch (e) { return null; }
  const full = path.resolve(ROOT, '.' + (p.startsWith('/') ? p : '/' + p));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end();
  }
  let file = resolveSafe(req.url || '/');
  if (!file) { res.writeHead(403); return res.end('forbidden'); }

  let st;
  try { st = fs.statSync(file); } catch (e) { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) {
    const idx = path.join(file, 'index.html');
    try { st = fs.statSync(idx); file = idx; } catch (e) { res.writeHead(404); return res.end('not found'); }
  }

  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // Weak validators are enough here and cost nothing to compute.
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',            // ⚠ the whole point — advertise it, then honour it
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    // No caching, deliberately: a rig that picks up a stale worker or wasm after
    // a relink is the torn-pair failure that has faked emulator bugs here.
    'Cache-Control': 'no-store',
  };

  if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end(); }

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, Object.assign({}, base, { 'Content-Range': `bytes */${st.size}` }));
      return res.end();
    }
    let start, end;
    if (m[1] === '') {                    // suffix form: last N bytes
      const n = Number(m[2]);
      start = Math.max(0, st.size - n); end = st.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
    }
    if (!(start >= 0) || start > end || start >= st.size) {
      res.writeHead(416, Object.assign({}, base, { 'Content-Range': `bytes */${st.size}` }));
      return res.end();
    }
    res.writeHead(206, Object.assign({}, base, {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': String(end - start + 1),
    }));
    if (method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  res.writeHead(200, Object.assign({}, base, { 'Content-Length': String(st.size) }));
  if (method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

server.listen(PORT, () => {
  console.log(`[devserver] ${ROOT} on http://localhost:${PORT}  (Range: yes — python3 -m http.server does NOT)`);
});
