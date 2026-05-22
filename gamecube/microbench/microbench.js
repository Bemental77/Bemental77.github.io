// microbench.js — page-side controller for the ppc-worker dispatch microbench.
// Topic: gamecube/docs/native-speed-gap-test/TASKS.md.

const $ = (id) => document.getElementById(id);
const out = $('out');
const coiSpan = $('coi');
const winitSpan = $('winit');

coiSpan.textContent = self.crossOriginIsolated ? 'yes' : 'no (SAB unavailable — reload once)';
coiSpan.className = self.crossOriginIsolated ? 'ok' : 'err';

// Allocate one shared WebAssembly.Memory the worker will inherit. The
// ppc-worker wasm was built with INITIAL_MEMORY=536870912 (8192 pages)
// per build_ppc_worker.sh; the imported memory must declare ≥ that.
const PAGES = 8192;            // 8192 × 64 KB = 512 MB (matches build)
const MAX_PAGES = 16384;       // 1 GB cap
let wasmMemory;
try {
  wasmMemory = new WebAssembly.Memory({
    initial: PAGES, maximum: MAX_PAGES, shared: true,
  });
} catch (e) {
  out.textContent = 'fatal: WebAssembly.Memory(shared) failed — ' + (e?.message || e)
    + '\n(SharedArrayBuffer requires cross-origin isolation; reload the page once.)';
  out.className = 'err';
  throw e;
}

// Classic worker (not type: 'module') — microbench_worker.js uses importScripts
// to load the emcc-generated ppc_worker_mb.js (which is not an ES module).
const worker = new Worker('./microbench_worker.js');

const results = {
  fixture: null,
  runs: [],   // { layer, iters, ms, rate_disp_per_sec, acc, ts }
  context: {
    user_agent: navigator.userAgent,
    pages: PAGES,
    started_iso: new Date().toISOString(),
  },
};

const pending = new Map();
let nextId = 1;

worker.onmessage = (e) => {
  const { id, type, payload, err } = e.data || {};
  if (type === 'log') {
    console.log('[mb-worker]', payload);
    return;
  }
  if (type === 'init-done') {
    winitSpan.textContent = 'ready (handle=' + payload.handle + ')';
    winitSpan.className = payload.handle >= 0 ? 'ok' : 'err';
    results.fixture = payload;
    render();
    return;
  }
  if (id && pending.has(id)) {
    const { resolve, reject } = pending.get(id);
    pending.delete(id);
    if (err) reject(new Error(err));
    else resolve(payload);
  }
};

worker.onerror = (e) => {
  winitSpan.textContent = 'error: ' + (e?.message || e);
  winitSpan.className = 'err';
  console.error('[mb-worker error]', e);
};

function send(type, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

worker.postMessage({ id: 0, type: 'mem-init', payload: { memory: wasmMemory } });

async function runLayer(layer, iters, warmup, trials) {
  if (warmup > 0) await send('run', { layer, iters: warmup });
  for (let t = 0; t < trials; ++t) {
    const r = await send('run', { layer, iters });
    results.runs.push({
      layer, trial: t, iters,
      ms:                 r.ms,
      rate_disp_per_sec:  Math.round(iters * 1000 / r.ms),
      acc:                r.acc >>> 0,
      ts:                 new Date().toISOString(),
    });
    render();
  }
}

function summarize(layer) {
  const rs = results.runs.filter((r) => r.layer === layer);
  if (rs.length === 0) return null;
  const sorted = rs.map((r) => r.rate_disp_per_sec).sort((a, b) => a - b);
  return {
    trials: rs.length,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    last_ms: rs[rs.length - 1].ms,
  };
}

function render() {
  const summary = {
    L0_empty_emasm:   summarize('L0'),
    L1_dispatch_raw:  summarize('L1'),
    L2_c_direct:      summarize('L2'),
  };
  // Compute deltas (cost-per-dispatch in nanoseconds).
  const ns = (rate) => rate ? Math.round(1e9 / rate) : null;
  const deltas = {
    L0_ns_per_call:           ns(summary.L0_empty_emasm?.median),
    L1_ns_per_dispatch:       ns(summary.L1_dispatch_raw?.median),
    L2_ns_per_dispatch:       ns(summary.L2_c_direct?.median),
  };
  // 486 MHz target.
  const NATIVE = 486_000_000;
  const pctNative = (rate) => rate ? +(100 * rate / NATIVE).toFixed(3) : null;
  const ratios = {
    L0_pct_of_native: pctNative(summary.L0_empty_emasm?.median),
    L1_pct_of_native: pctNative(summary.L1_dispatch_raw?.median),
    L2_pct_of_native: pctNative(summary.L2_c_direct?.median),
    L2_over_L1:       summary.L1_dispatch_raw && summary.L2_c_direct
                       ? +(summary.L2_c_direct.median / summary.L1_dispatch_raw.median).toFixed(2)
                       : null,
  };
  const json = {
    fixture: results.fixture,
    summary, deltas, ratios,
    context: results.context,
    runs: results.runs,
  };
  out.className = '';
  out.textContent = JSON.stringify(json, null, 2);
  results._json = json;
}

$('run-l0').onclick = () => runLayer('L0', +$('iters').value, +$('warmup').value, +$('trials').value);
$('run-l1').onclick = () => runLayer('L1', +$('iters').value, +$('warmup').value, +$('trials').value);
$('run-l2').onclick = () => runLayer('L2', +$('iters').value, +$('warmup').value, +$('trials').value);
$('run-all').onclick = async () => {
  const iters = +$('iters').value, warmup = +$('warmup').value, trials = +$('trials').value;
  await runLayer('L0', iters, warmup, trials);
  await runLayer('L1', iters, warmup, trials);
  await runLayer('L2', iters, warmup, trials);
};
$('copy-json').onclick = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(results._json || {}, null, 2));
    $('copy-json').textContent = 'copied!';
    setTimeout(() => ($('copy-json').textContent = 'Copy JSON'), 1200);
  } catch (e) { alert('clipboard error: ' + e.message); }
};
