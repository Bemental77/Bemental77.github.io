// tools/pokemonarena_overlay.mjs -- TEST-ONLY: serve a MUTATED copy of pokemonarena/ in front of the real dev server.
//
// The mutant runs of the W1 tests (pokemonarena_devices_test.mjs, pokemonarena_coherence_test.mjs) need the browser to run a copy of the game with
// ONE defect in it, while the ROM, lib/ and everything else still come from the real tree (the ROM is 32 MB and never copied). So:
//
//   const ov = await startOverlay({ dir: '<temp copy of pokemonarena/>', port: 8111, upstream: 'http://127.0.0.1:8101' });
//   ... open http://127.0.0.1:8111/pokemonarena/ ...
//   ov.stop();
//
// A request under /pokemonarena/ is answered from `dir` when the file exists there, and every other request (and every missing file) is forwarded
// to `upstream` (the real tools/devserver.mjs). Plain GET only, no Range of its own: Range headers are forwarded for the upstream (the ROM).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** Copy pokemonarena/ (without anything big) into `dest` and return `dest`. */
export function copyTree(srcDir, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
  }
  return dest;
}

/** Apply ONE textual defect to a file of the copy; the text must occur exactly `count` times (default 1) or this throws (a refactor cannot turn a mutant into a no-op). */
export function mutateFile(dir, rel, from, to, count = 1) {
  const p = path.join(dir, rel);
  const s = fs.readFileSync(p, 'utf8');
  const n = s.split(from).length - 1;
  if (n !== count) throw new Error(`mutation target found ${n}x in ${rel} (want ${count}): ${from.slice(0, 70)}`);
  fs.writeFileSync(p, s.split(from).join(to));
}

export async function startOverlay({ dir, port, upstream }) {
  const root = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname.startsWith('/pokemonarena/')) {
        const rel = decodeURIComponent(u.pathname.slice('/pokemonarena/'.length)) || 'index.html';
        const f = path.resolve(root, rel.endsWith('/') ? rel + 'index.html' : rel);
        if (f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
          res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
          res.end(fs.readFileSync(f)); return;
        }
      }
      const headers = { ...req.headers }; delete headers.host;
      const r = await fetch(upstream + req.url, { method: req.method, headers, redirect: 'manual' });
      const out = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
      res.writeHead(r.status, out);
      if (!r.body) { res.end(); return; }
      const reader = r.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; if (!res.write(Buffer.from(value))) await new Promise((ok) => res.once('drain', ok)); }
      res.end();
    } catch (e) { try { res.writeHead(502); res.end(String(e && e.message ? e.message : e)); } catch (_e) { /* gone */ } }
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  return { port, url: 'http://127.0.0.1:' + port, stop: () => { try { server.closeAllConnections && server.closeAllConnections(); server.close(); } catch (_e) { /* ignore */ } } };
}
