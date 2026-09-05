#!/usr/bin/env python3
"""Report the largest function bodies in a .wasm, and fail if any exceeds V8's cap.

WHY THIS EXISTS.  A full-image static-recomp link produced a module that Chrome refuses
to load, with an error that names a size and nothing else:

    CompileError: WebAssembly.instantiate(): size 9938512 > maximum function size
    7654321 @+29246752

That is a LINK-TIME defect with a RUN-TIME-only symptom: emcc exits 0, the .wasm and .mjs
are written, every byte count looks plausible, and the failure appears only when a browser
tries to instantiate it -- where it reads like an emulator bug rather than a build bug.
Worse, the error names no function, because -O2 strips the name section; identifying the
offender took a deliberate relink with names preserved.  This script closes that gap so
the build fails loudly, at the point of production, with the function NAMED.

The cap is V8's, not the spec's: v8/src/wasm/wasm-limits.h kV8MaxWasmFunctionSize.  Other
engines differ, so a module passing here is not portable by construction -- it is merely
not broken in the engine this project ships to.

USAGE
    python3 gamecube/tools/wasm_max_body.py <file.wasm> [--top N] [--cap BYTES] [--quiet]
    # exit 0 = every body within cap; exit 1 = at least one over (names it); 2 = bad input

The walker is deliberately dependency-free and reads only the section framing plus the
code and name sections -- it does not decode instructions, so it stays correct as the
instruction set grows.
"""
import struct
import sys

V8_MAX_FUNCTION_SIZE = 7654321  # v8/src/wasm/wasm-limits.h kV8MaxWasmFunctionSize


def uleb(buf, p):
    """Read one LEB128 unsigned int at p; return (value, new_p)."""
    r = s = 0
    while True:
        b = buf[p]
        p += 1
        r |= (b & 0x7F) << s
        if not b & 0x80:
            return r, p
        s += 7


def parse(data):
    """Return (bodies, names): bodies = [(size, func_index)], names = {index: name}.

    Function indices are module-wide, so imported functions occupy the low indices and the
    code section's Nth body is function (import_count + N).  Getting that wrong shifts
    every name by the import count, which is exactly the kind of silent off-by-N that
    would make this tool worse than useless -- so the import count is counted, not assumed.
    """
    if data[:4] != b"\0asm":
        raise ValueError("not a wasm module (bad magic)")
    p, imports, bodies, names = 8, 0, [], {}
    while p < len(data):
        sid = data[p]
        p += 1
        size, p = uleb(data, p)
        end = p + size
        if sid == 2:  # import: count only the FUNCTION imports
            n, q = uleb(data, p)
            for _ in range(n):
                for _field in range(2):  # module, then field name
                    ln, q = uleb(data, q)
                    q += ln
                kind = data[q]
                q += 1
                if kind == 0x00:  # func
                    imports += 1
                    _t, q = uleb(data, q)
                elif kind == 0x01:  # table
                    q += 1
                    fl = data[q]
                    q += 1
                    _mn, q = uleb(data, q)
                    if fl & 1:
                        _mx, q = uleb(data, q)
                elif kind == 0x02:  # memory
                    fl = data[q]
                    q += 1
                    _mn, q = uleb(data, q)
                    if fl & 1:
                        _mx, q = uleb(data, q)
                elif kind == 0x03:  # global
                    q += 2
                else:
                    raise ValueError(f"unknown import kind {kind}")
        elif sid == 10:  # code
            n, q = uleb(data, p)
            for i in range(n):
                body, q = uleb(data, q)
                bodies.append((body, imports + i))
                q += body
        elif sid == 0:  # custom: look for "name"
            ln, q = uleb(data, p)
            if data[q:q + ln] == b"name":
                q += ln
                while q < end:
                    sub = data[q]
                    q += 1
                    sl, q = uleb(data, q)
                    stop = q + sl
                    if sub == 1:  # function names
                        cnt, r = uleb(data, q)
                        for _ in range(cnt):
                            idx, r = uleb(data, r)
                            nl, r = uleb(data, r)
                            names[idx] = data[r:r + nl].decode("utf-8", "replace")
                            r += nl
                    q = stop
        p = end
    return bodies, names


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__.strip().split("USAGE")[1].strip(), file=sys.stderr)
        return 2
    top = 5
    cap = V8_MAX_FUNCTION_SIZE
    quiet = "--quiet" in argv
    for i, a in enumerate(argv):
        if a == "--top":
            top = int(argv[i + 1])
        if a == "--cap":
            cap = int(argv[i + 1])
    try:
        bodies, names = parse(open(args[0], "rb").read())
    except (OSError, ValueError, IndexError) as e:
        print(f"[wasm-max-body] cannot read {args[0]}: {e}", file=sys.stderr)
        return 2
    if not bodies:
        print("[wasm-max-body] no code section", file=sys.stderr)
        return 2
    bodies.sort(reverse=True)
    over = [b for b in bodies if b[0] > cap]

    def label(idx):
        # -O2 strips the name section, so an unnamed index is the NORMAL case, not an
        # error.  Say so plainly rather than printing a bare number that reads like a name.
        return names.get(idx, f"func#{idx} (name section stripped -- relink to name it)")

    if not quiet:
        print(f"[wasm-max-body] {len(bodies)} bodies, cap {cap}, largest {top}:")
        for sz, idx in bodies[:top]:
            print(f"    {sz:>10}  {label(idx)}")
    if over:
        print(f"[wasm-max-body] FAIL: {len(over)} function(s) exceed V8's {cap}-byte cap.")
        for sz, idx in over:
            print(f"    {sz:>10}  {label(idx)}   (+{sz - cap} over)")
        print("[wasm-max-body] This module will NOT instantiate in Chrome. If the offender")
        print("    is sr_dispatch, it is wasm-opt's unbounded single-caller inliner --")
        print("    see the -ocimfs note in gamecube/recomp/sr/build_image.sh.")
        return 1
    if not quiet:
        print(f"[wasm-max-body] OK: largest body {bodies[0][0]} is within cap.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
