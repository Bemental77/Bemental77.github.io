#!/usr/bin/env python3
# gamecube/native/wb/uninstrument.py IN.wat OUT.wat EXCLUDE.txt
#
# binaryen's --instrument-memory routes EVERY store in the module through the write barrier. Most of
# them never touch game memory: Aurora's GX command processing alone was 46% of all dynamic stores
# (1.14 M stores a frame, measured with a counting barrier), and it only ever writes Aurora's own
# buffers. This removes the barrier from the functions named in EXCLUDE.txt (one Python regex per
# line, matched against the function's name; '#' comments) — their stores go straight to memory.
#
# A function may be listed ONLY if it never stores into the game's tracked range (rollback.c). The
# list in wb/exclude.txt was chosen from a second counting barrier that counted only in-range stores
# per site over a whole route (title, file select, board, minigames); a mistake shows up as a rollback
# that does not restore exactly (tools/mp4n_probe.mjs RBTEST: re-run mismatches, rb_hash vs
# rb_hash_full).
import re, sys

src, dst, excl = sys.argv[1:4]
pats = [re.compile(l.strip()) for l in open(excl) if l.strip() and not l.lstrip().startswith('#')]
text = open(src).read()

# which $fimport$N are the store hooks
hooks = {}
for m in re.finditer(r'\(import "env" "(store_ptr|store_val_i32|store_val_i64|store_val_f32|store_val_f64)" \(func (\$\S+)', text):
    hooks[m.group(2)] = 4 if m.group(1) == 'store_ptr' else 2   # args before the value expression is kept
if not hooks:
    sys.exit('uninstrument: no store hooks found (was the input instrumented?)')

def match_paren(s, i):
    """s[i] == '(' -> index of its matching ')'. Skips string literals."""
    depth = 0
    n = len(s)
    j = i
    while j < n:
        c = s[j]
        if c == '"':
            j += 1
            while s[j] != '"':
                j += 2 if s[j] == '\\' else 1
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return j
        j += 1
    raise ValueError('unbalanced')

def children(s, i, j):
    """top-level child s-expressions of the expression s[i..j] (inclusive parens)."""
    out = []
    k = i + 1
    while k < j:
        if s[k] == '(':
            e = match_paren(s, k)
            out.append((k, e))
            k = e + 1
        else:
            k += 1
    return out

hook_re = re.compile(r'\(call (' + '|'.join(re.escape(h) for h in hooks) + r')\s')

def strip_body(body):
    # from the last hook call to the first: an edit only moves text after the call being edited, so
    # every earlier match position stays valid, and a hook nested in another's argument (later in the
    # text) is always handled before the one around it
    matches = list(hook_re.finditer(body))
    for m in reversed(matches):
        i = m.start()
        j = match_paren(body, i)
        kids = children(body, i, j)
        a, b = kids[hooks[m.group(1)] - 1]         # the pointer / value is the last argument
        body = body[:i] + body[a:b + 1] + body[j + 1:]
    return body, len(matches)

out = []
pos = 0
nfun = nsite = 0
for m in re.finditer(r'\n \(func (\$\S+)', text):
    name = m.group(1)[1:]
    if not any(p.search(name) for p in pats):
        continue
    start = m.start() + 1
    end = match_paren(text, start)
    body, k = strip_body(text[start:end + 1])
    if k:
        out.append(text[pos:start]); out.append(body); pos = end + 1
        nfun += 1; nsite += k
out.append(text[pos:])
open(dst, 'w').write(''.join(out))
print('[wb] uninstrumented %d functions, %d store sites' % (nfun, nsite))
