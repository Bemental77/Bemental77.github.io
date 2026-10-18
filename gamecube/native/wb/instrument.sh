#!/usr/bin/env bash
# gamecube/native/wb/instrument.sh IN.wasm OUT.wasm — merge the rollback write barrier into the link output.
#   1. memory.copy / memory.fill become calls to the barrier's mp4web_mcopy / mp4web_mfill (text rewrite;
#      binaryen's instrumentation does not cover bulk ops)
#   2. binaryen --instrument-memory: every load/store routes through env.load_ptr/store_ptr/...
#   3. wasm-merge with wb/barrier.wat (named "env"): those imports, and the barrier entry points the C code
#      imports (mp4web_barrier_init/present), resolve inside the module
#   4. -O2 with the hooks inlined: the pass-through hooks vanish, the store hook's range filter inlines
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
# NO FUNCTION IS EXEMPT (an exclusion list was tried and dropped: an unvisited path could write game
# memory unlogged). The store check goes INLINE at every store site (wb/inline_hooks.py): no call unless
# the store may be a page's first write in the frame.
"$B/wasm-dis" "${F[@]}" "$T/b.wasm" -o "$T/b.wat"; rm -f "$T/b.wasm"
# the tracked range and the page table, from the link map (wasm-ld --Map, written next to IN by build.sh)
MAP="${WB_MAP:-${IN%.wasm}.map}"
read -r WB_BASE WB_PAGES WB_TABLE < <(python3 - "$MAP" <<'PY'
import re, sys
sym = {}
for l in open(sys.argv[1]):
    m = re.match(r'\s*([0-9a-f]+)\s+[0-9a-f]+\s+[0-9a-f]+\s+(mp4web_game_bss_b|mp4web_game_bss_e|mp4wb_table)\s*$', l)
    if m: sym[m.group(2)] = int(m.group(1), 16)
b = (sym['mp4web_game_bss_b'] + 4095) & ~4095; e = sym['mp4web_game_bss_e'] & ~4095
print(b, (e - b) >> 12, sym['mp4wb_table'])
PY
)
echo "[wb] tracked range 0x$(printf %x "$WB_BASE") + $WB_PAGES pages, table 0x$(printf %x "$WB_TABLE")"
# WB_NOINLINE=1 (diagnostic): leave binaryen's call to store_ptr at each site (barrier.wat: same check, out of line)
if [ "${WB_NOINLINE:-0}" = 1 ]; then mv "$T/b.wat" "$T/b2.wat"; else python3 "$HERE/inline_hooks.py" "$T/b.wat" "$T/b2.wat" "$WB_BASE" "$WB_PAGES" "$WB_TABLE"; rm -f "$T/b.wat"; fi
"$B/wasm-as" "${F[@]}" "$T/b2.wat" -o "$T/b.wasm"; rm -f "$T/b2.wat"
"$B/wasm-as" -g "${F[@]}" "$HERE/barrier.wat" -o "$T/barrier.wasm"
"$B/wasm-merge" "${F[@]}" "$T/b.wasm" main "$T/barrier.wasm" env -o "$T/c.wasm"; rm -f "$T/b.wasm"
# -O2 never inlined the store hook (binaryen's flexible inlining is -O3 only: Call 110,096 plain ->
# 315,881 with the barrier), hence inline_hooks.py; the barrier's slow paths stay out of line.
"$B/wasm-opt" "${F[@]}" --no-inline='mp4wb_*' -O2 --strip-debug "$T/c.wasm" -o "$OUT"
echo "[wb] $(stat -c %s "$IN") -> $(stat -c %s "$OUT") B"
