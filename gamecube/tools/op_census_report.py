#!/usr/bin/env python3
"""op_census_report.py — join emitted ops to executed frequency.

Reads the <pc>.wasm / <pc>.marks pairs op_census wrote, disassembles each body
with `wasm-objdump -d`, and attributes every emitted instruction to (a) the emit
phase it came from and (b) its wasm control-nesting depth. Weighted by the PC
histogram, that answers the question static op counts cannot:

    of the ops that actually EXECUTE inside wasm-function[13], what fraction is
    per-block fixed overhead and what fraction is guest work?

WHY THE DEPTH COLUMN IS THE POINT. Commit dd6759fb: psq_st's ~500-op quantized
tree sits behind `op_if` on st_type (jit_load_store.cpp:2116/:2173) and the
FLOAT path never enters it, so its static size overstates executed cost ~10x.
Any op at depth > the phase's entry depth is behind a branch and MUST NOT be
counted as executed without naming which arm runs. So this reports two numbers
per phase, never one: `d0` (unconditional given the phase is reached) and `cond`
(gated — an upper bound only).

Ops are counted as `wasm-objdump -d` instruction lines, NOT bytes: the emitters
bake host addresses as LEB i32.const (cr_encode.cpp:30-31, ppc_emit.cpp:199-200)
so byte totals carry a ~0.16% link-layout artifact (CLAUDE.md gate #10).

KNOWN LIMITATION — two-arm blocks. A block with an FPR single/double
speculation guard emits the body TWICE (`ppc_emit.cpp:1805+`), so the marks
repeat. Only the first BLOCK_BEGIN is honoured, but the second arm's body still
lands inside the first arm's terminal span, so those blocks report an absurd
`terminal` (hundreds to thousands of ops) and a correspondingly small `body`.
Measured on the SAB corpus: 268 of 276 blocks are single-arm and clean; the 8
affected ones are identifiable because they move by an exact MULTIPLE of the
single-arm delta under an A/B. Their PHASE LABELS are wrong; their DELTAS are
not. Fixing this needs per-arm span nesting. Until then, read the per-block
terminal column (a hard constant on single-arm blocks) in preference to the
weighted phase total, which the artifact inflates.

Usage: op_census_report.py <census_dir> <manifest.weights>
"""
import os, re, subprocess, sys, collections

TAG = {0: 'prologue', 1: 'body', 2: 'op', 3: 'terminal', 4: 'end'}

# Control ops. `else` keeps the depth (it closes one arm and opens the sibling).
OPENERS = ('block', 'loop', 'if', 'try')
LINE_RE = re.compile(r'^\s*([0-9a-f]+):\s+(?:[0-9a-f]{2}\s+)+\|\s*(\S+)')
# `local[a..b] type=X` lines share this shape but are the locals declaration,
# not code; they always precede the first mark so the span filter drops them.


def disasm(path):
    """-> [(byte_off, mnemonic, depth_before_this_op)] for the single code body."""
    out = subprocess.run(['wasm-objdump', '-d', path],
                         capture_output=True, text=True).stdout
    ops, depth = [], 0
    for line in out.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        off, mn = int(m.group(1), 16), m.group(2)
        if mn == 'end':
            depth -= 1
            ops.append((off, mn, depth))
            continue
        ops.append((off, mn, depth))
        if mn in OPENERS:
            depth += 1
    return ops


def main():
    cdir, wpath = sys.argv[1], sys.argv[2]
    weights, bucket_of, blocks_in_bucket = {}, {}, {}
    for ln in open(wpath):
        f = ln.split()
        if len(f) >= 4:
            weights[f[0]] = float(f[1])
            bucket_of[f[0]] = f[2]
            blocks_in_bucket[f[0]] = int(f[3])

    phase_d0 = collections.Counter()
    phase_cond = collections.Counter()
    per_block = []
    n_inst_total = 0.0
    w_total = 0.0

    for fn in sorted(os.listdir(cdir)):
        if not fn.endswith('.marks'):
            continue
        pc = fn[:-6]
        w = weights.get(pc, 0.0)
        marks, n_insts = [], 0
        for ln in open(os.path.join(cdir, fn)):
            f = ln.split()
            if f and f[0] == 'mark':
                marks.append((int(f[1]), f[2], int(f[3])))
            elif f and f[0] == 'inst':
                n_insts += 1
        if not marks:
            continue
        ops = disasm(os.path.join(cdir, pc + '.wasm'))
        if not ops:
            continue

        # Marks are byte offsets into the WHOLE module; the disassembly's offsets
        # are too, so they compose directly. Build [start,end) spans in order.
        # A block with an FPR-speculation entry guard emits the body TWICE (two
        # arms, ppc_emit.cpp:1805+); marks then repeat. Keep only the FIRST arm:
        # exactly one arm runs per entry, so counting both would double-count.
        spans, seen_begin = [], False
        for i, (tag, mpc, off) in enumerate(marks):
            if tag == 0:
                if seen_begin:
                    break
                seen_begin = True
            end = marks[i + 1][2] if i + 1 < len(marks) else ops[-1][0] + 1
            spans.append((tag, mpc, off, end))

        counts = collections.defaultdict(lambda: [0, 0])   # phase -> [d0, cond]
        # Depth at the start of each span defines "unconditional for this phase".
        for tag, mpc, s, e in spans:
            name = TAG.get(tag, str(tag))
            if name == 'end':
                continue
            base = None
            for off, mn, d in ops:
                if off < s or off >= e:
                    continue
                if base is None:
                    base = d
                if d <= base:
                    counts[name][0] += 1
                else:
                    counts[name][1] += 1
        d0 = sum(v[0] for v in counts.values())
        cond = sum(v[1] for v in counts.values())
        for k, v in counts.items():
            phase_d0[k] += v[0] * w
            phase_cond[k] += v[1] * w
        per_block.append((w, pc, n_insts, d0, cond, dict(counts),
                          bucket_of.get(pc, '?'), blocks_in_bucket.get(pc, 0)))
        n_inst_total += n_insts * w
        w_total += w

    tot_d0 = sum(phase_d0.values())
    tot_cond = sum(phase_cond.values())
    print(f'blocks={len(per_block)}  weighted samples={w_total:.0f}  '
          f'mean guest instrs/block={n_inst_total / w_total:.2f}')
    print()
    print('SAMPLE-WEIGHTED EXECUTED-OP BUDGET  (d0 = unconditional; '
          'cond = behind an op_if, UPPER BOUND only)')
    print(f'{"phase":<12}{"d0 ops":>10}{"share":>9}{"cond ops":>11}{"cond share":>12}')
    for k in ('prologue', 'body', 'op', 'terminal'):
        if not phase_d0[k] and not phase_cond[k]:
            continue
        print(f'{k:<12}{phase_d0[k] / w_total:>10.1f}{phase_d0[k] / tot_d0 * 100:>8.1f}%'
              f'{phase_cond[k] / w_total:>11.1f}{phase_cond[k] / max(tot_cond,1) * 100:>11.1f}%')
    print(f'{"TOTAL":<12}{tot_d0 / w_total:>10.1f}{"":>9}{tot_cond / w_total:>11.1f}')
    fixed = (phase_d0['prologue'] + phase_d0['terminal']) / w_total
    print()
    print(f'per-block FIXED overhead (prologue + terminal, unconditional) = '
          f'{fixed:.1f} ops of {tot_d0 / w_total:.1f} = '
          f'{fixed / (tot_d0 / w_total) * 100:.1f}% of unconditional executed ops')
    print('   ^ ratio-of-sums. It assumes a bucket\'s samples split EVENLY across the')
    print('     block entries recovered in it, which over-weights long blocks a loop')
    print('     may never enter. The estimator below does not make that assumption.')

    # Sample-weighted mean of each block's OWN fixed/total ratio. Under the
    # standard sampling model (samples_b is proportional to exec_b * ops_b,
    # i.e. to TIME), executed-fixed / executed-total collapses exactly to this
    # weighted mean of ratios — the per-block ops_b cancels, so a long block no
    # longer needs a matching execution count to be weighted correctly.
    num = den = 0.0
    for w, pc, gi, d0, cond, c, bk, nb in per_block:
        if d0:
            num += w * (c.get('prologue', [0, 0])[0] + c.get('terminal', [0, 0])[0]) / d0
            den += w
    print(f'   sample-weighted MEAN of per-block fixed/total = {num / den * 100:.1f}%')

    print()
    print('BY BLOCK LENGTH  (the SAB regime is short blocks — this is where the tax lands)')
    print(f'{"guest instrs":<14}{"blocks":>7}{"weight":>10}{"mean d0":>9}'
          f'{"mean fixed":>11}{"fixed %":>9}')
    for lo, hi, lbl in ((1, 1, '1'), (2, 2, '2'), (3, 5, '3-5'), (6, 9, '6-9'),
                        (10, 19, '10-19'), (20, 999, '20+')):
        sel = [b for b in per_block if lo <= b[2] <= hi]
        if not sel:
            continue
        ws = sum(b[0] for b in sel)
        if ws <= 0:
            continue
        md0 = sum(b[0] * b[3] for b in sel) / ws
        mfx = sum(b[0] * (b[5].get('prologue', [0, 0])[0] +
                          b[5].get('terminal', [0, 0])[0]) for b in sel) / ws
        print(f'{lbl:<14}{len(sel):>7}{ws:>10.0f}{md0:>9.1f}{mfx:>11.1f}'
              f'{mfx / md0 * 100:>8.1f}%')
    print(f'guest work (body+op, unconditional) = '
          f'{(phase_d0["body"] + phase_d0["op"]) / w_total:.1f} ops for '
          f'{n_inst_total / w_total:.2f} guest instrs = '
          f'{(phase_d0["body"] + phase_d0["op"]) / n_inst_total:.1f} ops/guest instr')
    print()
    print('TOP BLOCKS BY WEIGHT')
    print(f'{"weight":>9} {"pc":>9} {"gi":>3} {"d0":>5} {"cond":>5} '
          f'{"prol":>5} {"term":>5} {"body":>5}  bucket(nblk)')
    for w, pc, gi, d0, cond, c, bk, nb in sorted(per_block, reverse=True)[:22]:
        print(f'{w:>9.1f} {pc:>9} {gi:>3} {d0:>5} {cond:>5} '
              f'{c.get("prologue",[0,0])[0]:>5} {c.get("terminal",[0,0])[0]:>5} '
              f'{c.get("body",[0,0])[0] + c.get("op",[0,0])[0]:>5}  {bk}({nb})')


main()
