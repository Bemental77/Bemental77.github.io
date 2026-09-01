#!/usr/bin/env python3
"""Offline validator for an ASYNCIFY_ADD list under ASYNCIFY_IGNORE_INDIRECT.

Reproduces what binaryen will do:
  instrumented = ancestors_over_DIRECT_edges( async imports  U  add-list matches )
(ASYNCIFY_PROPAGATE_ADD=1 is emscripten's default, so add-list entries propagate
to their direct callers exactly like the async roots do.)

Reports: per-pattern match counts, unmatched patterns (which binaryen would warn
about), the resulting instrumented-set size, and whether any hot-path function
leaked back in.

Run it BEFORE spending a link on an asyncify_add.txt edit. Widening a pattern is
NOT the safe direction: PROPAGATE_ADD walks upward, so a pattern that matches any
function the hot path calls drags the whole emulator back into the instrumented
set. This script catches that offline.

Inputs (regenerate after any relink; W = the wasm you are reasoning about):
    wasm-opt -all --print-call-graph W -o /dev/null > $DIR/callgraph.dot
    wasm-opt -all --func-metrics     W -o /dev/null | grep '^func: ' \
        | sed 's/^func: //' > $DIR/names.txt
where DIR defaults to /tmp/asyncify-advise (override with ASYNCIFY_WORKDIR).

usage: check_asyncify_addlist.py <addlist.txt>
exit 0 = clean; exit 1 = hot-path leakage and/or a pattern binaryen would warn on.
"""
import sys, re, os, collections

DIR = os.environ.get('ASYNCIFY_WORKDIR', '/tmp/asyncify-advise')
DOT = os.path.join(DIR, 'callgraph.dot')
NAMES = os.path.join(DIR, 'names.txt')
ROOTS = ['emscripten_sleep', '__wasi_fd_sync', 'em_libusb_wait_async']
HOT = ['WriteToHardware', 'ReadFromHardware', 'JitWasm::', 'bem_chain', 'bem_',
       'VertexManagerBase::', 'OpcodeDecoder::', 'TextureCacheBase::',
       'VertexLoader', 'Core::System::System', 'CPU::CPUManager::Break',
       'JitInterface::', 'CachedInterpreter::']


def dec(n):
    return (n.replace('\\28', '(').replace('\\29', ')').replace('\\2c', ',')
             .replace('\\20', ' ').replace('\\5b', '[').replace('\\5d', ']')
             .replace('\\27', "'").replace('\\7e', '~'))


def main(path):
    edge = re.compile(r'^\s*"(.*)" -> "(.*)";')
    preds = collections.defaultdict(set)
    for line in open(DOT, encoding='utf-8', errors='replace'):
        m = edge.match(line)
        if m:
            a, b = m.group(1), m.group(2)
            if a == 'A' and b == 'B':
                continue
            preds[b].add(a)

    names = [l.rstrip('\n') for l in open(NAMES)]
    pats = [l.strip() for l in open(path) if l.strip()]

    add, unmatched = set(), []
    print(f'--- {len(pats)} patterns in {path} ---')
    for p in pats:
        rx = re.compile('^' + '.*'.join(re.escape(x) for x in p.split('*')) + '$')
        m = [n for n in names if rx.match(dec(n))]
        add.update(m)
        print(f'{len(m):5d}  {p}' + ('   <-- NO MATCH: binaryen will warn' if not m else ''))
        if not m:
            unmatched.append(p)

    seen = set(ROOTS) | add
    stack = list(seen)
    while stack:
        n = stack.pop()
        for q in preds.get(n, ()):
            if q not in seen:
                seen.add(q)
                stack.append(q)
    seen -= set(ROOTS)

    d = [dec(n) for n in seen]
    print(f'\ndirectly matched by the add-list : {len(add)}')
    print(f'added by direct-call propagation : {len(seen) - len(add)}')
    print(f'INSTRUMENTED SET                 : {len(seen)} of {len(names)} '
          f'({100.0*len(seen)/len(names):.1f}%)')
    print(f'commas in entries (irrelevant for add-list, matters for only-list): '
          f'{sum(1 for n in d if "," in n)}')
    leaks = 0
    for h in HOT:
        c = sum(1 for n in d if h in n)
        if c:
            leaks += c
            print(f'  !! HOT-PATH LEAK {h!r}: {c}')
    print('  no hot-path leakage' if not leaks else f'  TOTAL LEAKS: {leaks}')
    if unmatched:
        print(f'  !! {len(unmatched)} unmatched pattern(s)')
    return 1 if (leaks or unmatched) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
