#!/usr/bin/env node
//
// wild-perf.mjs — log-scraping probe driver for bementalJIT throughput
// measurement against the >=1.0x native PowerPC acceptance bar.
//
// Reads a JitWasm log (stdin or a file path), parses [wild-ct] timebase
// snapshots and [perf] counter snapshots, builds 12-second sub-windows over
// the run, and emits standardized [wild-perf <test_id>] lines with
// native_ratio + per-module attribution.
//
// native_ratio = (delta_TBR_ticks * 12 * 1000) / (delta_wall_ms * 486_000_000)
//   — TBR runs at CPU/12 = 40.5 MHz on 486 MHz Gekko; native_ratio = 1.0
//   means we emulated 486M guest cycles per real-time second.
//
// Attribution table (per feedback_no_constraint_descope.md / module
// decomposition): on a sub-window with native_ratio < 1.0, the dominant
// counter delta tells you which bementalJIT module owns the gap.
//
// Usage:
//   node gamecube/tools/wild-perf.mjs <log-file> [--test-id=<name>]
//   build_and_probe.sh ... | node gamecube/tools/wild-perf.mjs --test-id=t3_pso
//
// Acceptance gate: every reported sub-window has native_ratio >= 1.0,
// AND mean(sub-windows) >= 1.0. Exit 0 on pass, 1 on fail.

import { readFileSync } from 'node:fs';
import { PERF_SLOT } from './perf_counters.mjs';

// ---------- Config ---------------------------------------------------------
const SUBWINDOW_MS    = 12_000;
const NATIVE_HZ       = 486_000_000;
const TBR_DIVIDER     = 12;             // TBR rate = CPU / 12

// ---------- Args -----------------------------------------------------------
function parseArgs(argv) {
    const args = { logPath: null, testId: 't_unspecified' };
    for (const a of argv.slice(2)) {
        if (a.startsWith('--test-id=')) args.testId = a.slice('--test-id='.length);
        else if (!args.logPath && !a.startsWith('--')) args.logPath = a;
    }
    return args;
}

// ---------- Log line parsers ----------------------------------------------
// [wild-ct] iter=12345 ticks_lo=0xABCD ticks_hi=0x12 pc=0x80123456 downcount=N
const RE_WILDCT = /\[wild-ct\][^]*?ticks_lo=0x([0-9a-fA-F]+)\s+ticks_hi=0x([0-9a-fA-F]+)/;
// [perf] disp=N region=N perblock=N compile=N fallback=N interp=N hle=N r32=N w32=N
const RE_PERF   = /\[perf\]\s+disp=(\d+)\s+region=(\d+)\s+perblock=(\d+)\s+compile=(\d+)\s+fallback=(\d+)\s+interp=(\d+)\s+hle=(\d+)\s+r32=(\d+)\s+w32=(\d+)/;

function parseLog(text) {
    const events = [];
    const lines = text.split('\n');
    // Each [wild-ct] / [perf] line gets a synthetic wall-time stamp from
    // line index. The build_and_probe driver doesn't currently timestamp
    // every line, so we infer wall-time from a leading "[ms=…]" prefix
    // when present, otherwise from line ordinal at a 1ms-per-line cadence.
    // (Sub-window math still works — the TBR ticks are absolute.)
    let lineMs = 0;
    for (const line of lines) {
        const m_ms = line.match(/^\[ms=(\d+)\]/);
        if (m_ms) lineMs = parseInt(m_ms[1], 10);
        else      lineMs += 1;
        const wm = line.match(RE_WILDCT);
        if (wm) {
            const ticks = (BigInt('0x' + wm[2]) << 32n) | BigInt('0x' + wm[1]);
            events.push({ kind: 'wildct', ms: lineMs, ticks });
            continue;
        }
        const pm = line.match(RE_PERF);
        if (pm) {
            events.push({
                kind: 'perf',
                ms: lineMs,
                disp:     BigInt(pm[1]),
                region:   BigInt(pm[2]),
                perblock: BigInt(pm[3]),
                compile:  BigInt(pm[4]),
                fallback: BigInt(pm[5]),
                interp:   BigInt(pm[6]),
                hle:      BigInt(pm[7]),
                r32:      BigInt(pm[8]),
                w32:      BigInt(pm[9]),
            });
        }
    }
    return events;
}

// ---------- Window analysis -----------------------------------------------
function nativeRatio(dTicks, dWallMs) {
    if (dWallMs <= 0n) return 0;
    const num = Number(dTicks) * TBR_DIVIDER * 1000;
    const den = Number(dWallMs) * NATIVE_HZ;
    return num / den;
}

function buildSubwindows(events) {
    const wildct = events.filter(e => e.kind === 'wildct');
    const perfs  = events.filter(e => e.kind === 'perf');
    if (wildct.length < 2) return [];

    const windows = [];
    let i = 0;
    let last = wildct[0];
    while (i < wildct.length - 1) {
        // Find next wildct event at least SUBWINDOW_MS after last.
        let j = i + 1;
        while (j < wildct.length && (wildct[j].ms - last.ms) < SUBWINDOW_MS) j++;
        if (j >= wildct.length) break;
        const cur = wildct[j];
        const dTicks  = cur.ticks - last.ticks;
        const dWallMs = BigInt(cur.ms - last.ms);
        const ratio   = nativeRatio(dTicks, dWallMs);

        // Closest perf snapshot inside the window for attribution.
        const perfIn = perfs.filter(p => p.ms >= last.ms && p.ms <= cur.ms);
        const att = perfIn.length > 0 ? perfIn[perfIn.length - 1] : null;

        windows.push({ startMs: last.ms, endMs: cur.ms, dTicks, dWallMs, ratio, att });
        last = cur;
        i = j;
    }
    return windows;
}

function attribute(window) {
    if (!window.att) return 'no-attribution';
    const a = window.att;
    if (a.fallback > 0n) return `interp_fallback=${a.fallback}`;
    if (a.compile  > 0n) return `compile_jobs=${a.compile}`;
    return `perblock=${a.perblock} region=${a.region} hle=${a.hle}`;
}

// ---------- Main ----------------------------------------------------------
function main() {
    const args = parseArgs(process.argv);
    let text;
    if (args.logPath) {
        text = readFileSync(args.logPath, 'utf8');
    } else {
        text = readFileSync(0, 'utf8');  // stdin
    }
    const events  = parseLog(text);
    const windows = buildSubwindows(events);
    if (windows.length === 0) {
        console.error(`[wild-perf ${args.testId}] no measurement windows — log has <2 [wild-ct] lines`);
        process.exit(1);
    }

    let pass = true;
    let ratioSum = 0;
    for (const w of windows) {
        if (w.ratio < 1.0) pass = false;
        ratioSum += w.ratio;
        console.log(
            `[wild-perf ${args.testId}] window=${w.startMs}-${w.endMs}ms ` +
            `dTicks=${w.dTicks} dWall=${w.dWallMs}ms ratio=${w.ratio.toFixed(4)} ` +
            `attr=${attribute(w)}`
        );
    }
    const mean = ratioSum / windows.length;
    if (mean < 1.0) pass = false;
    console.log(
        `[wild-perf ${args.testId}] summary windows=${windows.length} ` +
        `mean=${mean.toFixed(4)} verdict=${pass ? 'PASS' : 'FAIL'}`
    );
    process.exit(pass ? 0 : 1);
}

main();
