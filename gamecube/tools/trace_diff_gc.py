#!/usr/bin/env python3
"""
trace_diff_gc.py — GameCube-only native-vs-wasm block-PC trajectory differ.

Finds the first divergence between native Dolphin's block-PC sequence and our
wasm build's block-PC sequence.

NATIVE input formats (--native FILE):
  Format A: Simple hex per line (one PC per line), with or without 0x prefix.
            Examples:  "0x80003140"  or  "80003140"
  Format B: Dolphin NOTICE_LOG lines containing "[traj] <hex8>", as emitted by
            Jit64::TrajHere (gamecube/dolphin-src/…/Jit64/Jit.cpp:460).
            Full log line: "01:23:45:678 Jit.cpp:461 N[POWERPC]: [traj] 80003140"
            The extractor looks for the literal token "[traj] " followed by a
            hex string anywhere on a line.
  Format C: GDB single-step output from gdb_osexc_step.py / gdb_si_step.py.
            Lines like: "  [  0] pc=0x80003140 r0=0x..."
            Extracts the first "pc=0x<hex>" token per line.
  (Formats are auto-detected; unknown lines are silently skipped.)

WASM input (--wasm FILE):
  Probe log from build_and_probe.sh, e.g. /tmp/probes/si-diag.log.
  Parsed line sources (in priority order, finest-grained first):

  PRIMARY — Run() entry lines (one per dispatch yield):
    "  [jit] Run() entry #N pc=XXXXXXXX mem_3a30=0x... ..."
    The pc= field immediately after "entry #N " is the dispatch-yield PC (no 0x prefix).
    Example: "  [jit] Run() entry #1 pc=80003140 mem_3a30=0x3ec06000 ..."
    These are the per-dispatch-yield PCs logged by JitWasm.cpp:2282-2290.

  SECONDARY (landmark only) — [jit-inner] lines (powers-of-10 sampling):
    "  [jit-inner] it=N pc=0x<hex> ..."
    Only used if no Run() entry lines are found in the file.

  FALLBACK — [jit] FIRST dispatch line:
    "  [jit] FIRST dispatch pc=<hex> next=<hex>"
    Included as a single entry at the front of the wasm sequence when present
    and chronologically before any Run() entry #1. (Normally Run() entry #1
    matches this PC so the effect is deduplication.)

ALIGNMENT MODES (--mode):
  exact      (default) Align both sequences index-by-index from position 0.
             Reports first index i where native[i] != wasm[i].
             Use when both traces have the same granularity (e.g. both block-level).

  subseq     Check that wasm is a subsequence of native (i.e. every wasm PC
             appears in native order but native may have additional PCs between
             them). Reports the first wasm PC that breaks the subsequence order.
             Use when wasm is coarser (fewer entries per real time).

  landmark   Scan native for the first wasm PC, advance both, repeat. Like subseq
             but also reports native PCs that were skipped over between landmarks.
             Use to identify which native blocks the wasm never reaches.

OUTPUT:
  Prints the last N matched PCs (default 20) then the divergence point, with
  context lines from each sequence.

  --context N     Number of preceding matched PCs to show (default 20).
  --after N       Number of following PCs to show on each side (default 5).
  --no-dedup      By default consecutive duplicate PCs in WASM are collapsed
                  (repeated dispatch yields to the same PC are common during
                  poll loops and inflate the sequence without adding information).
                  --no-dedup disables collapsing.
  --show-wasm N   Print first N PCs of extracted wasm sequence and total count,
                  then exit. Used to validate the wasm extractor.
  --synthetic-test Inject a synthetic native file from the wasm sequence with one
                  PC perturbed, run the differ, print result, then exit. Used to
                  prove the divergence finder works.
"""

import argparse
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------

_RE_TRAJ = re.compile(r'\[traj\]\s+([0-9a-fA-F]{1,16})\b')
_RE_GDB_PC = re.compile(r'\[\s*\d+\]\s+pc=(?:0x)?([0-9a-fA-F]{1,8})\b')
_RE_SIMPLE_HEX = re.compile(r'^(?:0x)?([0-9a-fA-F]{6,8})\s*$')

_RE_RUN_ENTRY = re.compile(
    r'\[jit\]\s+Run\(\)\s+entry\s+#\d+\s+pc=([0-9a-fA-F]{1,8})\b'
)
_RE_JIT_INNER = re.compile(
    r'\[jit-inner\]\s+it=\d+\s+pc=(?:0x)?([0-9a-fA-F]{1,8})\b'
)
_RE_FIRST_DISPATCH = re.compile(
    r'\[jit\]\s+FIRST\s+dispatch\s+pc=([0-9a-fA-F]{1,8})\b'
)


def _parse_pc(hex_str: str) -> int:
    return int(hex_str, 16)


def extract_native(path: str) -> list[int]:
    """Parse a native Dolphin trajectory file.  Auto-detects format per line."""
    pcs: list[int] = []
    with open(path, 'r', errors='replace') as f:
        for line in f:
            # Format B: [traj] hex (Dolphin NOTICE_LOG)
            m = _RE_TRAJ.search(line)
            if m:
                pcs.append(_parse_pc(m.group(1)))
                continue
            # Format C: GDB single-step "  [  N] pc=0x..."
            m = _RE_GDB_PC.search(line)
            if m:
                pcs.append(_parse_pc(m.group(1)))
                continue
            # Format A: bare hex line
            m = _RE_SIMPLE_HEX.match(line.strip())
            if m:
                pcs.append(_parse_pc(m.group(1)))
                continue
    return pcs


def extract_wasm(path: str, dedup: bool = True) -> tuple[list[int], str]:
    """Parse a wasm probe log.  Returns (pc_list, source_description).

    Source priority:
      1. [jit] Run() entry #N pc=<hex>   (primary, per-dispatch-yield)
      2. [jit-inner] it=N pc=<hex>       (secondary, powers-of-10 sample)
    [jit] FIRST dispatch pc=<hex> is included as position-0 seed if present
    and the Run() entry sequence starts after it (dedup handles exact repeats).
    """
    run_entries: list[int] = []
    inner_entries: list[int] = []
    wtraj_entries: list[int] = []
    first_dispatch: int | None = None

    with open(path, 'r', errors='replace') as f:
        for line in f:
            # Per-block trajectory ring (native-granularity): "[wtraj] h h h ..."
            wi = line.find('[wtraj] ')
            if wi >= 0:
                wtraj_entries.extend(int(t, 16) for t in
                                     re.findall(r'[0-9a-fA-F]{1,8}', line[wi + 8:]))
                continue
            m = _RE_FIRST_DISPATCH.search(line)
            if m and first_dispatch is None:
                first_dispatch = _parse_pc(m.group(1))
                continue
            m = _RE_RUN_ENTRY.search(line)
            if m:
                run_entries.append(_parse_pc(m.group(1)))
                continue
            m = _RE_JIT_INNER.search(line)
            if m:
                inner_entries.append(_parse_pc(m.group(1)))

    if wtraj_entries:
        raw = wtraj_entries
        source = "[wtraj] per-block dispatch ring (native-granularity)"
    elif run_entries:
        raw = run_entries
        source = "[jit] Run() entry #N pc=<hex>  (per-dispatch-yield)"
    elif inner_entries:
        raw = inner_entries
        source = "[jit-inner] it=N pc=<hex>  (powers-of-10 sample, coarse)"
    else:
        raw = []
        source = "(no wasm trajectory lines found)"

    # Prepend FIRST dispatch if it differs from entry[0] (avoids double-count)
    if first_dispatch is not None and (not raw or raw[0] != first_dispatch):
        raw = [first_dispatch] + raw

    if dedup:
        # Collapse consecutive duplicates (poll loops yield same PC repeatedly)
        deduped: list[int] = []
        prev: int | None = None
        for pc in raw:
            if pc != prev:
                deduped.append(pc)
                prev = pc
        pcs = deduped
    else:
        pcs = raw

    return pcs, source


# ---------------------------------------------------------------------------
# Diff modes
# ---------------------------------------------------------------------------

def _fmt_pc(pc: int) -> str:
    return f"0x{pc:08x}"


def _show_context(label: str, seq: list[int], start: int, count: int) -> None:
    end = min(start + count, len(seq))
    for i in range(start, end):
        print(f"    [{i:6d}] {_fmt_pc(seq[i])}")
    if end < len(seq):
        remaining = len(seq) - end
        print(f"    ... ({remaining} more)")


def diff_exact(
    native: list[int],
    wasm: list[int],
    context_before: int = 20,
    context_after: int = 5,
) -> None:
    """Exact index-by-index alignment."""
    n = min(len(native), len(wasm))
    div_idx = None
    for i in range(n):
        if native[i] != wasm[i]:
            div_idx = i
            break

    if div_idx is None:
        if len(native) == len(wasm):
            print(f"MATCH: both sequences identical ({n} entries).")
        else:
            print(
                f"PREFIX MATCH up to index {n - 1} (all {n} entries matched).\n"
                f"  native has {len(native)} entries total.\n"
                f"  wasm   has {len(wasm)} entries total.\n"
                f"  Sequences agree on the common prefix; one ends first."
            )
        return

    print(f"DIVERGENCE at index {div_idx}:")
    print()
    ctx_start = max(0, div_idx - context_before)
    print(f"  --- Last {div_idx - ctx_start} matched PCs (index {ctx_start}..{div_idx-1}) ---")
    for i in range(ctx_start, div_idx):
        print(f"    [{i:6d}] {_fmt_pc(native[i])}  (native == wasm)")
    print()
    print(f"  --- Divergence at index {div_idx} ---")
    print(f"    NATIVE[{div_idx}]: {_fmt_pc(native[div_idx])}")
    print(f"    WASM  [{div_idx}]: {_fmt_pc(wasm[div_idx])}")
    print()
    print(f"  --- Native context after divergence (next {context_after}) ---")
    _show_context("native", native, div_idx + 1, context_after)
    print(f"  --- WASM context after divergence (next {context_after}) ---")
    _show_context("wasm", wasm, div_idx + 1, context_after)


def diff_subseq(
    native: list[int],
    wasm: list[int],
    context_before: int = 20,
    context_after: int = 5,
) -> None:
    """Check wasm is a subsequence of native.  Reports the first wasm PC
    that cannot be found in native after the previous match position."""
    ni = 0  # native cursor
    wi = 0  # wasm cursor
    matched: list[tuple[int, int, int]] = []  # (wi, ni, pc)

    while wi < len(wasm) and ni < len(native):
        if native[ni] == wasm[wi]:
            matched.append((wi, ni, wasm[wi]))
            wi += 1
        ni += 1

    if wi == len(wasm):
        print(
            f"SUBSEQUENCE MATCH: all {len(wasm)} wasm entries appear in native order.\n"
            f"  native length: {len(native)}, wasm length: {len(wasm)}."
        )
        return

    # wasm[wi] was never found at or after native[ni-1]
    fail_wi = wi
    fail_pc = wasm[fail_wi]

    print(f"SUBSEQUENCE BREAK at wasm index {fail_wi}:")
    print(f"  wasm PC {_fmt_pc(fail_pc)} not found in native after native[{ni-1}]={_fmt_pc(native[ni-1])}.")
    print()
    ctx_start = max(0, len(matched) - context_before)
    print(f"  --- Last {len(matched) - ctx_start} subsequence matches ---")
    for (wi2, ni2, pc) in matched[ctx_start:]:
        print(f"    wasm[{wi2:6d}] matched native[{ni2:6d}]: {_fmt_pc(pc)}")
    print()
    print(f"  --- Unmatched wasm tail (first {context_after}) ---")
    for k in range(fail_wi, min(fail_wi + context_after, len(wasm))):
        print(f"    wasm[{k:6d}]: {_fmt_pc(wasm[k])}")
    print()
    print(f"  --- Remaining native from failure point (first {context_after}) ---")
    for k in range(ni, min(ni + context_after, len(native))):
        print(f"    native[{k:6d}]: {_fmt_pc(native[k])}")


def diff_landmark(
    native: list[int],
    wasm: list[int],
    context_before: int = 20,
    context_after: int = 5,
) -> None:
    """Like subseq, but also reports native PCs skipped over between landmarks."""
    ni = 0
    wi = 0
    matched: list[tuple[int, int, int, int]] = []  # (wi, ni, pc, skipped_count)
    prev_ni = 0

    while wi < len(wasm) and ni < len(native):
        if native[ni] == wasm[wi]:
            skipped = ni - prev_ni - (1 if matched else 0)
            matched.append((wi, ni, wasm[wi], max(0, skipped)))
            prev_ni = ni
            wi += 1
        ni += 1

    if wi == len(wasm):
        total_skipped = sum(m[3] for m in matched)
        print(
            f"LANDMARK MATCH: all {len(wasm)} wasm landmarks found in native.\n"
            f"  native length: {len(native)}, wasm length: {len(wasm)}.\n"
            f"  Total native PCs skipped between landmarks: {total_skipped}."
        )
        ctx_start = max(0, len(matched) - context_before)
        print(f"\n  --- Last {len(matched) - ctx_start} matches ---")
        for (wi2, ni2, pc, skipped) in matched[ctx_start:]:
            skip_note = f" (+{skipped} skipped)" if skipped else ""
            print(f"    wasm[{wi2:6d}] -> native[{ni2:6d}]: {_fmt_pc(pc)}{skip_note}")
        return

    fail_wi = wi
    fail_pc = wasm[fail_wi]
    print(f"LANDMARK BREAK at wasm index {fail_wi}:")
    print(f"  wasm PC {_fmt_pc(fail_pc)} not found in native after native[{ni-1}]={_fmt_pc(native[ni-1])}.")
    print()
    ctx_start = max(0, len(matched) - context_before)
    print(f"  --- Last {len(matched) - ctx_start} matched landmarks ---")
    for (wi2, ni2, pc, skipped) in matched[ctx_start:]:
        skip_note = f" (+{skipped} native skipped)" if skipped else ""
        print(f"    wasm[{wi2:6d}] -> native[{ni2:6d}]: {_fmt_pc(pc)}{skip_note}")
    print()
    print(f"  --- Unmatched wasm tail (first {context_after}) ---")
    for k in range(fail_wi, min(fail_wi + context_after, len(wasm))):
        print(f"    wasm[{k:6d}]: {_fmt_pc(wasm[k])}")
    print()
    print(f"  --- Remaining native from failure point (first {context_after}) ---")
    for k in range(ni, min(ni + context_after, len(native))):
        print(f"    native[{k:6d}]: {_fmt_pc(native[k])}")


# ---------------------------------------------------------------------------
# Synthetic test helper
# ---------------------------------------------------------------------------

def run_synthetic_test(wasm_pcs: list[int]) -> None:
    """Build a synthetic native sequence from wasm_pcs, perturb index 10 (or
    the midpoint if len < 20), run all three diff modes, print results."""
    if not wasm_pcs:
        print("SYNTHETIC-TEST: wasm sequence is empty — nothing to test.", file=sys.stderr)
        return

    import tempfile, os

    # Build native = wasm_pcs expanded (each entry repeated twice to make it
    # strictly longer) then perturb one entry.
    expanded = []
    for pc in wasm_pcs:
        expanded.append(pc)
        expanded.append(pc)  # duplicate to make native denser than wasm

    perturb_idx = min(10, len(expanded) - 1)
    original_pc = expanded[perturb_idx]
    perturbed_pc = (original_pc ^ 0x00000004) & 0xFFFFFFFF  # flip bit 2

    synthetic_native = list(expanded)
    synthetic_native[perturb_idx] = perturbed_pc

    # Write synthetic native to a temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.log', delete=False,
                                     prefix='synth_native_') as tf:
        for pc in synthetic_native:
            tf.write(f"0x{pc:08x}\n")
        tmppath = tf.name

    print("=" * 70)
    print("SYNTHETIC TEST")
    print(f"  wasm entries:   {len(wasm_pcs)}")
    print(f"  native entries: {len(synthetic_native)}  (wasm×2, each PC duplicated)")
    print(f"  perturbation:   native[{perturb_idx}] = 0x{original_pc:08x} → 0x{perturbed_pc:08x}")
    print(f"  temp file:      {tmppath}")
    print()

    native_loaded = extract_native(tmppath)
    print(f"  native loaded:  {len(native_loaded)} PCs")
    print()

    for mode_name, mode_fn in [
        ("exact", diff_exact),
        ("subseq", diff_subseq),
        ("landmark", diff_landmark),
    ]:
        print(f"--- Mode: {mode_name} ---")
        mode_fn(native_loaded, wasm_pcs, context_before=5, context_after=3)
        print()

    os.unlink(tmppath)
    print("=" * 70)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument('--native', metavar='FILE',
                    help='Native Dolphin trajectory file (hex-per-line or [traj] log).')
    ap.add_argument('--wasm', metavar='FILE',
                    help='Wasm probe log (e.g. /tmp/probes/si-diag.log).')
    ap.add_argument('--mode', choices=['exact', 'subseq', 'landmark'],
                    default='exact',
                    help='Alignment mode (default: exact).')
    ap.add_argument('--context', type=int, default=20, metavar='N',
                    help='Matched PCs to show before divergence (default 20).')
    ap.add_argument('--after', type=int, default=5, metavar='N',
                    help='Context lines after divergence on each side (default 5).')
    ap.add_argument('--no-dedup', action='store_true',
                    help='Disable collapsing of consecutive duplicate wasm PCs.')
    ap.add_argument('--show-wasm', type=int, default=0, metavar='N',
                    help='Print first N PCs of wasm sequence + total count, then exit.')
    ap.add_argument('--synthetic-test', action='store_true',
                    help='Run synthetic divergence test (requires --wasm; no --native needed).')
    args = ap.parse_args()

    if not args.wasm and not args.native:
        ap.print_help()
        sys.exit(0)

    # --- Wasm extraction ---
    wasm_pcs: list[int] = []
    wasm_source = ""
    if args.wasm:
        wasm_pcs, wasm_source = extract_wasm(args.wasm, dedup=not args.no_dedup)

    # --- show-wasm mode ---
    if args.show_wasm > 0:
        print(f"Wasm source: {wasm_source}")
        print(f"Total PCs:   {len(wasm_pcs)}")
        print(f"First {min(args.show_wasm, len(wasm_pcs))}:")
        for i, pc in enumerate(wasm_pcs[:args.show_wasm]):
            print(f"  [{i:6d}] {_fmt_pc(pc)}")
        return

    # --- synthetic-test mode ---
    if args.synthetic_test:
        if not wasm_pcs:
            print("ERROR: --synthetic-test requires --wasm with parseable entries.",
                  file=sys.stderr)
            sys.exit(1)
        run_synthetic_test(wasm_pcs)
        return

    # --- Normal diff mode ---
    if not args.native:
        print("ERROR: --native FILE is required for diff mode.", file=sys.stderr)
        sys.exit(1)
    if not args.wasm:
        print("ERROR: --wasm FILE is required for diff mode.", file=sys.stderr)
        sys.exit(1)

    native_pcs = extract_native(args.native)

    print(f"Native file:   {args.native}")
    print(f"  PCs loaded:  {len(native_pcs)}")
    print(f"  First:       {_fmt_pc(native_pcs[0]) if native_pcs else '(empty)'}")
    print(f"  Last:        {_fmt_pc(native_pcs[-1]) if native_pcs else '(empty)'}")
    print()
    print(f"Wasm file:     {args.wasm}")
    print(f"  Source:      {wasm_source}")
    print(f"  PCs loaded:  {len(wasm_pcs)}")
    print(f"  First:       {_fmt_pc(wasm_pcs[0]) if wasm_pcs else '(empty)'}")
    print(f"  Last:        {_fmt_pc(wasm_pcs[-1]) if wasm_pcs else '(empty)'}")
    print()
    print(f"Mode: {args.mode}")
    print()

    if args.mode == 'exact':
        diff_exact(native_pcs, wasm_pcs,
                   context_before=args.context, context_after=args.after)
    elif args.mode == 'subseq':
        diff_subseq(native_pcs, wasm_pcs,
                    context_before=args.context, context_after=args.after)
    else:
        diff_landmark(native_pcs, wasm_pcs,
                      context_before=args.context, context_after=args.after)


if __name__ == '__main__':
    main()
