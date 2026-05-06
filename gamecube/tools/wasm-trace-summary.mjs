#!/usr/bin/env node
//
// wasm-trace-summary.mjs — read a chrome://tracing JSON dump captured by
// dolphin_render_probe.js and report V8 WebAssembly compilation events.
//
// Goal per the V8 research: confirm whether bementalJIT-emitted modules
// promote Liftoff → TurboFan during the run. If we never see OptimizeCode
// events, modules are being discarded before the tier-up budget trips
// and steady-state throughput stays at Liftoff baseline.
//
// Usage:
//   node gamecube/tools/wasm-trace-summary.mjs /tmp/probe-trace.json

import { readFileSync } from 'node:fs';

function summarize(events) {
    const result = {
        total_events: events.length,
        wasm_compile: 0,                  // Liftoff baseline compile
        wasm_optimize: 0,                  // TurboFan tier-up
        wasm_instantiate: 0,
        wasm_decode: 0,
        first_compile_us: null,
        first_optimize_us: null,
        last_optimize_us: null,
        total_compile_dur_us: 0,
        total_optimize_dur_us: 0,
        compile_per_sec: 0,
        optimize_per_sec: 0,
    };
    let runStart = null, runEnd = null;
    for (const e of events) {
        if (typeof e.ts !== 'number') continue;
        runStart = runStart === null ? e.ts : Math.min(runStart, e.ts);
        runEnd   = runEnd   === null ? e.ts : Math.max(runEnd,   e.ts);
        const name = e.name || '';
        // V8 names these depending on version: wasm.CompileBaseline,
        // wasm.CompileTopTier, wasm.CompileCode, wasm.OptimizeCode,
        // wasm.Instantiate, wasm.Decode. Match generously.
        if (/^wasm\.Compile(Baseline|Code)$/.test(name)) {
            result.wasm_compile++;
            if (result.first_compile_us === null) result.first_compile_us = e.ts;
            if (typeof e.dur === 'number') result.total_compile_dur_us += e.dur;
        } else if (/^wasm\.(Optimize|CompileTopTier)/.test(name)) {
            result.wasm_optimize++;
            if (result.first_optimize_us === null) result.first_optimize_us = e.ts;
            result.last_optimize_us = e.ts;
            if (typeof e.dur === 'number') result.total_optimize_dur_us += e.dur;
        } else if (/^wasm\.Instantiate/.test(name)) {
            result.wasm_instantiate++;
        } else if (/^wasm\.Decode/.test(name)) {
            result.wasm_decode++;
        }
    }
    const runDurUs = (runEnd != null && runStart != null) ? (runEnd - runStart) : 0;
    if (runDurUs > 0) {
        const sec = runDurUs / 1e6;
        result.compile_per_sec  = +(result.wasm_compile  / sec).toFixed(2);
        result.optimize_per_sec = +(result.wasm_optimize / sec).toFixed(2);
    }
    result.run_duration_s = +(runDurUs / 1e6).toFixed(3);
    return result;
}

function main() {
    const path = process.argv[2];
    if (!path) {
        console.error('usage: wasm-trace-summary.mjs <probe-trace.json>');
        process.exit(2);
    }
    const raw = readFileSync(path, 'utf8');
    let trace;
    try { trace = JSON.parse(raw); }
    catch (e) { console.error('parse failed: ' + e.message); process.exit(1); }
    const events = Array.isArray(trace) ? trace : (trace.traceEvents || []);
    const s = summarize(events);

    console.log('[wasm-trace] events=' + s.total_events + ' run=' + s.run_duration_s + 's');
    console.log('[wasm-trace] compile=' + s.wasm_compile + ' (' + s.compile_per_sec + '/s)' +
                ' optimize=' + s.wasm_optimize + ' (' + s.optimize_per_sec + '/s)' +
                ' instantiate=' + s.wasm_instantiate + ' decode=' + s.wasm_decode);
    if (s.first_compile_us  != null) console.log('[wasm-trace] first_compile_at  = ' + (s.first_compile_us / 1e6).toFixed(3) + 's');
    if (s.first_optimize_us != null) console.log('[wasm-trace] first_optimize_at = ' + (s.first_optimize_us / 1e6).toFixed(3) + 's');
    if (s.last_optimize_us  != null) console.log('[wasm-trace] last_optimize_at  = ' + (s.last_optimize_us  / 1e6).toFixed(3) + 's');
    console.log('[wasm-trace] total_compile_us=' + s.total_compile_dur_us +
                ' total_optimize_us=' + s.total_optimize_dur_us);

    // Headline verdict per the V8 research finding: tier-up to TurboFan is
    // the primary lever toward >=1.0x native. Zero optimize events means
    // we're stuck at Liftoff baseline.
    if (s.wasm_optimize === 0) {
        console.log('[wasm-trace] VERDICT: NO TurboFan tier-up observed — modules likely discarded before tier-up budget trips');
        process.exit(1);
    }
    console.log('[wasm-trace] VERDICT: TurboFan tier-up confirmed (' + s.wasm_optimize + ' OptimizeCode events)');
}

main();
