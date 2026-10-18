#!/usr/bin/env python3
# gamecube/native/wb/inline_hooks.py IN.wat OUT.wat BASE PAGES TABLE — writes the write barrier's store check INLINE at
# every store site of a module that binaryen's --instrument-memory has instrumented.
#
# Why: binaryen turns each store's address into `(call $store_ptr id bytes offset PTR)`. -O2 never
# inlined that call (binaryen's flexible inlining needs -O3), so every one of the module's ~204,000
# stores paid a 4-argument call, and once logging was on, two more calls (mark_in, mark) for every
# store into game memory — measured +1.5 ms a frame with logging on (probe busy 7.7 -> 9.3 ms).
#
# Each site becomes, with BASE / PAGES (the tracked range, page-aligned) and TABLE (src/rollback.c
# mp4wb_table) baked in as constants read from the link map (d = PTR + offset - BASE):
#   if d + 8 <u PAGES*4096 + 8                   ; [BASE - 8, end): may touch tracked memory
#     if d <s 0                                  ;   starts just below BASE: the slow path decides
#        || TABLE[d >> 12] == 0                  ;   first write to this page in the open frame
#        || (multi-byte) (a & 4095) > 4096 - n   ;   crosses into the next page
#       call $__wb_slow(a, n)                    ;   = barrier.wat mp4wb_slow: logs what needs logging
# and the address PTR passes through unchanged. Constants, not globals: no instance loads per store.
# Rollback off = TABLE all 1s (rollback.c), so the check never calls out.
import re, sys

src, dst = sys.argv[1:3]
BASE, PAGES, TABLE = (int(x, 0) for x in sys.argv[3:6])
SPAN8 = PAGES * 4096 + 8
text = open(src).read()

m = re.search(r'\(import "env" "store_ptr" \(func (\$\S+)', text)
if not m:
    sys.exit('inline_hooks: no store_ptr import (was the input instrumented?)')
HOOK = m.group(1)

def match_paren(s, i):
    depth = 0; j = i; n = len(s)
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
    out = []; k = i + 1
    while k < j:
        if s[k] == '(':
            e = match_paren(s, k); out.append((k, e)); k = e + 1
        else:
            k += 1
    return out

hook_re = re.compile(r'\(call ' + re.escape(HOOK) + r'\s')
const_re = re.compile(r'\(i32\.const (-?\d+)\)')

def i32(v):
    v &= 0xffffffff
    return v - (1 << 32) if v >= 1 << 31 else v

def site(ptr, nbytes, off):
    a = '(local.get $__wa)' if off == 0 else '(i32.add (local.get $__wa) (i32.const %d))' % i32(off)
    chk = ('(i32.or (i32.lt_s (local.get $__wd) (i32.const 0)) '
           '(i32.eqz (i32.load8_u (i32.add (i32.const %d) (i32.shr_u (local.get $__wd) (i32.const 12))))))' % TABLE)
    if nbytes > 1:   # a multi-byte store may cross into the next page: the slow path checks both
        chk = '(i32.or %s (i32.gt_u (i32.and %s (i32.const 4095)) (i32.const %d)))' % (chk, a, 4096 - nbytes)
    return ('(block (result i32) (local.set $__wa %s) '
            '(local.set $__wd (i32.sub %s (i32.const %d))) '
            '(if (i32.lt_u (i32.add (local.get $__wd) (i32.const 8)) (i32.const %d)) '
            '(then (if %s (then (call $__wb_slow %s (i32.const %d)))))) '
            '(local.get $__wa))') % (ptr, a, i32(BASE), i32(SPAN8), chk, a, nbytes)

def rewrite(body):
    # last hook first: an edit only moves text after it, and a hook nested in another's PTR (later in
    # the text) is rewritten before the one around it. Nested sites share $__wa/$__wd safely: an inner
    # site finishes inside the outer's PTR, before the outer sets them.
    ms = list(hook_re.finditer(body))
    for mm in reversed(ms):
        i = mm.start(); j = match_paren(body, i)
        kids = children(body, i, j)
        if len(kids) != 4:
            raise ValueError('store_ptr call with %d args' % len(kids))
        nb = const_re.fullmatch(body[kids[1][0]:kids[1][1] + 1])
        of = const_re.fullmatch(body[kids[2][0]:kids[2][1] + 1])
        if not nb or not of:
            raise ValueError('non-constant bytes/offset')
        ptr = body[kids[3][0]:kids[3][1] + 1]
        body = body[:i] + site(ptr, int(nb.group(1)), int(of.group(1)) & 0xffffffff) + body[j + 1:]
    return body, len(ms)

out = []; pos = 0; nf = ns = 0
for fm in re.finditer(r'\n \(func (\$\S+)[^\n]*\n', text):
    start = fm.start() + 1
    end = match_paren(text, start)
    body = text[start:end + 1]
    if not hook_re.search(body):
        continue
    body, k = rewrite(body)
    hl = fm.end() - start                       # the header line stays first; the two locals follow it
    body = body[:hl] + '  (local $__wa i32)\n  (local $__wd i32)\n' + body[hl:]
    out.append(text[pos:start]); out.append(body); pos = end + 1
    nf += 1; ns += k
out.append(text[pos:])
text = ''.join(out); out = None

# the slow path's import, right after the last import
decl_imp = ' (import "env" "mp4wb_slow" (func $__wb_slow (param i32 i32)))\n'
decl_def = ''
last = text.rfind('\n (import ')
e = text.index('\n', last + 1)
text = text[:e + 1] + decl_imp + decl_def + text[e + 1:]
open(dst, 'w').write(text)
print('[wb] store check inlined at %d sites in %d functions' % (ns, nf))
