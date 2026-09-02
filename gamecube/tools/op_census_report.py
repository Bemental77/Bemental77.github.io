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

# --------------------------------------------------------------------------
# Guest-opcode naming. BEM_MARK_OP (ppc_emit.cpp:1370) carries op.address, and
# the .marks file lists `inst <pc> <word>` for every decoded instruction, so a
# tag-2 span can be attributed to the GUEST instruction that produced it. That
# is the join this report was missing: phase totals say how much is fixed
# overhead, this says which guest instructions the non-fixed half is spent on.
# Unknown encodings degrade to `op<N>` / `op<N>.<xo>` rather than being dropped.
# --------------------------------------------------------------------------
_PRIMARY = {
    3: 'twi', 7: 'mulli', 8: 'subfic', 10: 'cmpli', 11: 'cmpi', 12: 'addic',
    13: 'addic.', 14: 'addi', 15: 'addis', 16: 'bc', 17: 'sc', 18: 'b',
    20: 'rlwimi', 21: 'rlwinm', 23: 'rlwnm', 24: 'ori', 25: 'oris',
    26: 'xori', 27: 'xoris', 28: 'andi.', 29: 'andis.',
    32: 'lwz', 33: 'lwzu', 34: 'lbz', 35: 'lbzu', 36: 'stw', 37: 'stwu',
    38: 'stb', 39: 'stbu', 40: 'lhz', 41: 'lhzu', 42: 'lha', 43: 'lhau',
    44: 'sth', 45: 'sthu', 46: 'lmw', 47: 'stmw',
    48: 'lfs', 49: 'lfsu', 50: 'lfd', 51: 'lfdu', 52: 'stfs', 53: 'stfsu',
    54: 'stfd', 55: 'stfdu', 56: 'psq_l', 57: 'psq_lu', 60: 'psq_st',
    61: 'psq_stu',
}
_X31 = {
    0: 'cmp', 8: 'subfc', 10: 'addc', 11: 'mulhwu', 19: 'mfcr', 20: 'lwarx',
    23: 'lwzx', 24: 'slw', 26: 'cntlzw', 28: 'and', 32: 'cmpl', 40: 'subf',
    54: 'dcbst', 55: 'lwzux', 60: 'andc', 75: 'mulhw', 83: 'mfmsr',
    86: 'dcbf', 87: 'lbzx', 104: 'neg', 119: 'lbzux', 124: 'nor',
    136: 'subfe', 138: 'adde', 144: 'mtcrf', 146: 'mtmsr', 150: 'stwcx.',
    151: 'stwx', 183: 'stwux', 200: 'subfze', 202: 'addze', 210: 'mtsr',
    215: 'stbx', 234: 'addme', 235: 'mullw', 247: 'stbux', 266: 'add',
    279: 'lhzx', 284: 'eqv', 311: 'lhzux', 316: 'xor', 339: 'mfspr',
    343: 'lhax', 371: 'mftb', 375: 'lhaux', 407: 'sthx', 412: 'orc',
    439: 'sthux', 444: 'or', 459: 'divwu', 467: 'mtspr', 470: 'dcbi',
    476: 'nand', 491: 'divw', 512: 'mcrxr', 533: 'lswx', 534: 'lwbrx',
    535: 'lfsx', 536: 'srw', 567: 'lfsux', 595: 'mfsr', 597: 'lswi',
    598: 'sync', 599: 'lfdx', 631: 'lfdux', 662: 'stwbrx', 663: 'stfsx',
    695: 'stfsux', 725: 'stswi', 727: 'stfdx', 759: 'stfdux', 790: 'lhbrx',
    792: 'sraw', 824: 'srawi', 854: 'eieio', 918: 'sthbrx', 922: 'extsh',
    954: 'extsb', 982: 'icbi', 983: 'stfiwx', 1014: 'dcbz',
}
_X19 = {0: 'mcrf', 16: 'bclr', 33: 'crnor', 50: 'rfi', 129: 'crandc',
        150: 'isync', 193: 'crxor', 225: 'crnand', 257: 'crand',
        289: 'creqv', 417: 'crorc', 449: 'cror', 528: 'bcctr'}
_X63 = {0: 'fcmpu', 12: 'frsp', 14: 'fctiw', 15: 'fctiwz', 32: 'fcmpo',
        38: 'mtfsb1', 40: 'fneg', 64: 'mcrfs', 70: 'mtfsb0', 72: 'fmr',
        134: 'mtfsfi', 136: 'fnabs', 264: 'fabs', 583: 'mffs', 711: 'mtfsf'}
_A5 = {18: 'fdiv', 20: 'fsub', 21: 'fadd', 22: 'fsqrt', 23: 'fsel',
       24: 'fres', 25: 'fmul', 26: 'frsqrte', 28: 'fmsub', 29: 'fmadd',
       30: 'fnmsub', 31: 'fnmadd'}
_PS5 = {10: 'ps_sum0', 11: 'ps_sum1', 12: 'ps_muls0', 13: 'ps_muls1',
        14: 'ps_madds0', 15: 'ps_madds1', 18: 'ps_div', 20: 'ps_sub',
        21: 'ps_add', 23: 'ps_sel', 24: 'ps_res', 25: 'ps_mul',
        26: 'ps_rsqrte', 28: 'ps_msub', 29: 'ps_madd', 30: 'ps_nmsub',
        31: 'ps_nmadd'}
_PS10 = {0: 'ps_cmpu0', 32: 'ps_cmpo0', 40: 'ps_neg', 64: 'ps_cmpu1',
         72: 'ps_mr', 96: 'ps_cmpo1', 136: 'ps_nabs', 264: 'ps_abs',
         528: 'ps_merge00', 560: 'ps_merge01', 592: 'ps_merge10',
         624: 'ps_merge11', 1014: 'dcbz_l'}


def ppc_mnemonic(w):
    op = (w >> 26) & 0x3f
    if op in _PRIMARY:
        return _PRIMARY[op]
    xo10 = (w >> 1) & 0x3ff
    xo5 = (w >> 1) & 0x1f
    if op == 31:
        return _X31.get(xo10, 'op31.%d' % xo10)
    if op == 19:
        return _X19.get(xo10, 'op19.%d' % xo10)
    if op == 63:
        if xo5 in _A5 and xo10 not in _X63:
            return _A5[xo5]
        return _X63.get(xo10, _A5.get(xo5, 'op63.%d' % xo10))
    if op == 59:
        return _A5.get(xo5, 'op59.%d' % xo5) + 's'
    if op == 4:
        if xo10 in _PS10:
            return _PS10[xo10]
        return _PS5.get(xo5, 'op4.%d' % xo10)
    return 'op%d' % op

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
    mnem_d0 = collections.Counter()     # (phase, wasm mnemonic) -> weighted ops
    mnem_cond = collections.Counter()
    gop_d0 = collections.Counter()      # guest mnemonic -> weighted d0 ops
    gop_cond = collections.Counter()
    gop_w = collections.Counter()       # guest mnemonic -> weighted occurrences
    gop_blocks = collections.defaultdict(set)
    gop_share = collections.Counter()   # NORMALIZED: share of executed d0 ops
    mn_share = collections.Counter()    # NORMALIZED: (fixed|guest, wasm mn)
    per_block = []
    n_inst_total = 0.0
    w_total = 0.0

    for fn in sorted(os.listdir(cdir)):
        if not fn.endswith('.marks'):
            continue
        pc = fn[:-6]
        w = weights.get(pc, 0.0)
        marks, n_insts, word_of = [], 0, {}
        for ln in open(os.path.join(cdir, fn)):
            f = ln.split()
            if f and f[0] == 'mark':
                marks.append((int(f[1]), f[2], int(f[3])))
            elif f and f[0] == 'inst':
                n_insts += 1
                word_of[f[1]] = int(f[2], 16)
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
        blk_gop = collections.Counter()    # this block: guest mnemonic -> d0 ops
        blk_mn = collections.Counter()     # this block: (fixed|guest, wasm mn) -> d0
        # Depth at the start of each span defines "unconditional for this phase".
        for tag, mpc, s, e in spans:
            name = TAG.get(tag, str(tag))
            if name == 'end':
                continue
            base = None
            sd0 = scond = 0
            for off, mn, d in ops:
                if off < s or off >= e:
                    continue
                if base is None:
                    base = d
                if d <= base:
                    counts[name][0] += 1
                    sd0 += 1
                    mnem_d0[(name, mn)] += w
                    blk_mn[('fixed' if name in ('prologue', 'terminal')
                            else 'guest', mn)] += 1
                else:
                    counts[name][1] += 1
                    scond += 1
                    mnem_cond[(name, mn)] += w
            if tag == 2 and mpc in word_of:
                gm = ppc_mnemonic(word_of[mpc])
                gop_d0[gm] += sd0 * w
                gop_cond[gm] += scond * w
                gop_w[gm] += w
                gop_blocks[gm].add(pc)
                blk_gop[gm] += sd0
        d0 = sum(v[0] for v in counts.values())
        cond = sum(v[1] for v in counts.values())
        # NORMALIZED estimator (the one the fixed-overhead headline already
        # uses): each block contributes its own COMPOSITION, weighted by its
        # sample share. Under samples_b ∝ exec_b * ops_b the per-block ops_b
        # cancels, so a 60-instruction FP routine no longer outvotes a 3-
        # instruction loop body purely by being longer. The ratio-of-sums
        # tables above do NOT have this property and over-weight long blocks.
        if d0:
            for gm, c in blk_gop.items():
                gop_share[gm] += w * c / d0
            for (ph, mn), c in blk_mn.items():
                mn_share[(ph, mn)] += w * c / d0
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
    num = den = pro = ter = 0.0
    for w, pc, gi, d0, cond, c, bk, nb in per_block:
        if d0:
            num += w * (c.get('prologue', [0, 0])[0] + c.get('terminal', [0, 0])[0]) / d0
            pro += w * c.get('prologue', [0, 0])[0] / d0
            ter += w * c.get('terminal', [0, 0])[0] / d0
            den += w
    print(f'   sample-weighted MEAN of per-block fixed/total = {num / den * 100:.1f}%'
          f'   (prologue {pro / den * 100:.1f}% + terminal {ter / den * 100:.1f}%)')

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
    print('GUEST-OPCODE BUDGET  (tag-2 spans only: the non-fixed half of the body)')
    print('  d0/occ = unconditional emitted ops per DYNAMIC occurrence of that guest')
    print('  instruction; cond/occ is behind an op_if and is an UPPER BOUND.')
    print(f'{"guest op":<12}{"occ (w)":>10}{"occ %":>8}{"d0 ops":>10}{"d0 %":>8}'
          f'{"d0/occ":>9}{"cond/occ":>10}{"blocks":>8}')
    g_tot_d0 = sum(gop_d0.values())
    g_tot_w = sum(gop_w.values())
    for gm, v in gop_d0.most_common(28):
        print(f'{gm:<12}{gop_w[gm]:>10.0f}{gop_w[gm] / g_tot_w * 100:>7.1f}%'
              f'{v:>10.0f}{v / g_tot_d0 * 100:>7.1f}%'
              f'{v / gop_w[gm]:>9.1f}{gop_cond[gm] / gop_w[gm]:>10.1f}'
              f'{len(gop_blocks[gm]):>8}')
    print(f'{"TOTAL":<12}{g_tot_w:>10.0f}{"":>8}{g_tot_d0:>10.0f}'
          f'{"":>8}{g_tot_d0 / g_tot_w:>9.1f}'
          f'{sum(gop_cond.values()) / g_tot_w:>10.1f}')

    print()
    print('*** NORMALIZED GUEST-OPCODE SHARE (the estimator to quote) ***')
    print('  Share of EXECUTED unconditional emitted ops, per-block-normalized so a')
    print('  long block cannot outvote a short one purely by length. Same estimator')
    print('  as the fixed-overhead headline above.')
    print(f'{"guest op":<12}{"share":>9}{"cum":>8}   {"vs ratio-of-sums":>18}')
    gs_tot = sum(gop_share.values())
    cum = 0.0
    for gm, v in gop_share.most_common(26):
        cum += v / w_total * 100
        ros = gop_d0[gm] / max(g_tot_d0, 1) * 100 * (g_tot_d0 / max(tot_d0, 1))
        print(f'{gm:<12}{v / w_total * 100:>8.2f}%{cum:>7.1f}%   {ros:>17.2f}%')
    print(f'{"[guest ops]":<12}{gs_tot / w_total * 100:>8.2f}%')
    print(f'{"[fixed]":<12}{num / den * 100:>8.2f}%   (prologue+terminal, same estimator)')

    print()
    print('WASM-MNEMONIC BUDGET  (normalized share of executed unconditional ops)')
    print('  What the 46x-amplified ops ARE. `fixed` = prologue+terminal.')
    hdr = ('mnemonic', 'fixed', 'guest', 'total')
    print(f'{hdr[0]:<22}{hdr[1]:>9}{hdr[2]:>9}{hdr[3]:>9}')
    by_mn = collections.Counter()
    for (ph, mn), v in mn_share.items():
        by_mn[mn] += v
    for mn, v in by_mn.most_common(26):
        print(f'{mn:<22}{mn_share[("fixed", mn)] / w_total * 100:>8.2f}%'
              f'{mn_share[("guest", mn)] / w_total * 100:>8.2f}%'
              f'{v / w_total * 100:>8.2f}%')

    print()
    print('TOP BLOCKS BY WEIGHT')
    print(f'{"weight":>9} {"pc":>9} {"gi":>3} {"d0":>5} {"cond":>5} '
          f'{"prol":>5} {"term":>5} {"body":>5}  bucket(nblk)')
    for w, pc, gi, d0, cond, c, bk, nb in sorted(per_block, reverse=True)[:22]:
        print(f'{w:>9.1f} {pc:>9} {gi:>3} {d0:>5} {cond:>5} '
              f'{c.get("prologue",[0,0])[0]:>5} {c.get("terminal",[0,0])[0]:>5} '
              f'{c.get("body",[0,0])[0] + c.get("op",[0,0])[0]:>5}  {bk}({nb})')


main()
