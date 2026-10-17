#!/usr/bin/env bash
# gamecube/native/wb/instrument.sh IN.wasm OUT.wasm — merge the rollback write barrier into the link output.
#   1. memory.copy / memory.fill become calls to the barrier's mp4web_mcopy / mp4web_mfill (text rewrite;
#      binaryen's instrumentation does not cover bulk ops)
#   2. binaryen --instrument-memory: every load/store routes through env.load_ptr/store_ptr/...
#   3. wasm-merge with wb/barrier.wat (named "env"): those imports, and the barrier entry points the C code
#      imports (mp4web_barrier_init/present), resolve inside the module
#   4. -O2 with generous inlining: the pass-through hooks vanish, the store hook inlines
set -euo pipefail
IN="$1"; OUT="$2"; HERE="$(cd "$(dirname "$0")" && pwd)"
B="${BINARYEN_BIN:-$HOME/emsdk-upstream/upstream/bin}"
T="$(mktemp -d "${TMPDIR:-/tmp}/mp4wb.XXXXXX")"; trap 'rm -rf "$T"' EXIT
F=(--all-features)
"$B/wasm-dis" "${F[@]}" "$IN" -o "$T/a.wat"
python3 - "$T/a.wat" <<'PY'
import sys, re
p = sys.argv[1]
with open(p) as f: s = f.read()
nc = s.count('(memory.copy'); nf = s.count('(memory.fill')
s = s.replace('(memory.copy', '(call $__mp4web_mcopy').replace('(memory.fill', '(call $__mp4web_mfill')
imp = ' (import "env" "mp4web_mcopy" (func $__mp4web_mcopy (param i32 i32 i32)))\n' \
      ' (import "env" "mp4web_mfill" (func $__mp4web_mfill (param i32 i32 i32)))\n'
# imports must precede every definition: put ours right after the last existing import
last = s.rfind('\n (import ')
end = s.index('\n', last + 1)
s = s[:end + 1] + imp + s[end + 1:]
with open(p, 'w') as f: f.write(s)
print('[wb] bulk ops rewritten: memory.copy %d, memory.fill %d' % (nc, nf))
PY
"$B/wasm-as" -g "${F[@]}" "$T/a.wat" -o "$T/a.wasm"; rm -f "$T/a.wat"
"$B/wasm-opt" -g "${F[@]}" --instrument-memory "$T/a.wasm" -o "$T/b.wasm"; rm -f "$T/a.wasm"
# the barrier off for functions that never store into game memory (wb/exclude.txt; needs the link's
# function names: build.sh links with --profiling-funcs)
if [ "${WB_EXCLUDE:-1}" = 1 ]; then
  "$B/wasm-dis" "${F[@]}" "$T/b.wasm" -o "$T/b.wat" && python3 "$HERE/uninstrument.py" "$T/b.wat" "$T/b2.wat" "$HERE/exclude.txt" \
    && rm -f "$T/b.wat" && "$B/wasm-as" -g "${F[@]}" "$T/b2.wat" -o "$T/b.wasm" && rm -f "$T/b2.wat"
fi
"$B/wasm-as" "${F[@]}" "$HERE/barrier.wat" -o "$T/barrier.wasm"
"$B/wasm-merge" "${F[@]}" "$T/b.wasm" main "$T/barrier.wasm" env -o "$T/c.wasm"; rm -f "$T/b.wasm"
"$B/wasm-opt" "${F[@]}" -O2 --flexible-inline-max-function-size=64 --strip-debug "$T/c.wasm" -o "$OUT"
echo "[wb] $(stat -c %s "$IN") -> $(stat -c %s "$OUT") B"
