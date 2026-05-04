#!/usr/bin/env python3
# parse_oracle.py — translate DolphinPPCTests' instruction_tests_console.txt
# into a C++ header with structured test cases for differential testing.
#
# Recognized line shapes (matching OPTEST_* macros in DolphinPPCTests/source/Integer.cpp):
#
#   OPTEST_3_COMPONENTS         INSTR :: rD <rD> | rA <rA> | rB <rB> | XER: <xer> | CR: <cr>
#   OPTEST_2_COMPONENTS         INSTR :: rD <rD> | rA <rA>          | XER: <xer> | CR: <cr>
#   OPTEST_3_COMPONENTS_IMM     INSTR :: rD <rD> | rA <rA> | imm <imm> | XER: <xer> | CR: <cr>
#   OPTEST_3_COMPONENTS_CMP     INSTR ::          | rA <rA> | rB <rB>  | XER: <xer> | CR: <cr>
#   OPTEST_3_COMPONENTS_CMP_IMM INSTR ::          | rA <rA> | imm <imm>| XER: <xer> | CR: <cr>
#   OPTEST_5_COMPONENTS         INSTR :: rD <rD> | rS <rS> | SH <SH> | MB: <MB> | ME: <ME> | XER: <xer> | CR: <cr>
#
# Output: a C++ header with one OracleCase entry per test. Each entry encodes
# the PPC instruction word, the input register/immediate values, and the
# expected post-state (rD or no-rD for CMP, XER, CR).
#
# Register convention (matches test_diff.cpp's TestEnv):
#   r3 = dest (rD or rA-output for logical/shift)
#   r4 = first source (rA in arith, rS in logical/shift)
#   r5 = second source (rB)

import re
import sys
from pathlib import Path

OPCODE_31 = 31

def x_arith(sub_op, rt, ra, rb, rc=0, oe=0):
    """X-form: opcode=31, RT=dest, RA=src1, RB=src2."""
    return ((OPCODE_31 << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
            | ((rb & 0x1F) << 11) | ((oe & 1) << 10) | ((sub_op & 0x3FF) << 1)
            | (rc & 1)) & 0xFFFFFFFF

def x_logic(sub_op, ra, rs, rb, rc=0):
    """X-form logical: opcode=31, RA=dest, RS=src1, RB=src2 (rA/rS swap from arith)."""
    return ((OPCODE_31 << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
            | ((rb & 0x1F) << 11) | ((sub_op & 0x3FF) << 1) | (rc & 1)) & 0xFFFFFFFF

def x_2op_arith(sub_op, rt, ra, rc=0, oe=0):
    """X-form 2-operand arith (NEG, ADDME, ADDZE, SUBFME, SUBFZE): RT=dest, RA=src."""
    return x_arith(sub_op, rt, ra, 0, rc=rc, oe=oe)

def x_2op_logic(sub_op, ra, rs, rc=0):
    """X-form 2-operand logical (CNTLZW, EXTSB, EXTSH): RA=dest, RS=src, RB=0."""
    return x_logic(sub_op, ra, rs, 0, rc=rc)

def d_form(opcode, rt, ra, simm):
    """D-form: opcode | RT | RA | SIMM. SIMM is treated as 16-bit (caller masks)."""
    return ((opcode << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
            | (simm & 0xFFFF)) & 0xFFFFFFFF

def d_form_logic(opcode, ra, rs, uimm):
    """D-form logical (ANDI., ORI, etc.): opcode | RS | RA | UIMM."""
    return ((opcode << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
            | (uimm & 0xFFFF)) & 0xFFFFFFFF

def x_cmp(sub_op, ra, rb, crfd=0, l=0):
    """X-form compare (CMP, CMPL): opcode=31, crfD<<23, L<<21, RA, RB."""
    return ((OPCODE_31 << 26) | ((crfd & 7) << 23) | ((l & 1) << 21)
            | ((ra & 0x1F) << 16) | ((rb & 0x1F) << 11) | ((sub_op & 0x3FF) << 1)) & 0xFFFFFFFF

def d_cmp(opcode, ra, simm, crfd=0, l=0):
    """D-form compare (CMPI, CMPLI): opcode | crfD<<23 | L<<21 | RA | SIMM."""
    return ((opcode << 26) | ((crfd & 7) << 23) | ((l & 1) << 21)
            | ((ra & 0x1F) << 16) | (simm & 0xFFFF)) & 0xFFFFFFFF

def m_form_rlw(opcode, ra, rs, sh, mb, me, rc=0):
    """M-form rotate-mask (RLWINM, RLWIMI): opcode | RS | RA | SH | MB | ME | Rc."""
    return ((opcode << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
            | ((sh & 0x1F) << 11) | ((mb & 0x1F) << 6) | ((me & 0x1F) << 1)
            | (rc & 1)) & 0xFFFFFFFF

# Register convention used by every test case:
DEST_REG, SRCA_REG, SRCB_REG = 3, 4, 5

# ---------------------------------------------------------------------------
# Mnemonic registry. For each mnemonic, returns (instruction_word) given the
# operand values from the OPTEST line. `imm` slot is unused for non-IMM forms.
# ---------------------------------------------------------------------------

ARITH_3_OPS = {
    # X-form 3-operand arith: rT=r3, rA=r4, rB=r5. May have OE/Rc suffix.
    'ADD':    (266, False),   # (sub_op, oe)
    'ADDC':    (10, False),
    'ADDE':   (138, False),
    'DIVW':   (491, False),
    'DIVWU':  (459, False),
    'MULHW':   (75, False),
    'MULHWU':  (11, False),
    'MULLW':  (235, False),
    'SUBF':    (40, False),
    'SUBFC':    (8, False),
    'SUBFE':  (136, False),
}

LOGIC_3_OPS = {
    'AND':    28,
    'ANDC':   60,
    'EQV':   284,
    'NAND':  476,
    'NOR':   124,
    'OR':    444,
    'ORC':   412,
    'XOR':   316,
    'SLW':    24,
    'SRW':   536,
    'SRAW':  792,
}

# 2-operand X-form arithmetic (rT=r3, rA=r4): NEG, ADDME, ADDZE, SUBFME, SUBFZE.
ARITH_2_OPS = {
    'NEG':     104,
    'ADDME':   234,
    'ADDZE':   202,
    'SUBFME':  232,
    'SUBFZE':  200,
}

# 2-operand X-form logical (rA=r3, rS=r4): CNTLZW, EXTSB, EXTSH.
LOGIC_2_OPS = {
    'CNTLZW':   26,
    'EXTSB':   954,
    'EXTSH':   922,
}

# D-form arithmetic with immediate: rT=r3, rA=r4, simm.
D_FORM_IMM = {
    'ADDI':   14,
    'ADDIS':  15,
    'ADDIC':  12,
    'ADDIC.': 13,
    'MULLI':   7,
    'SUBFIC':  8,
}

# D-form logical with unsigned immediate: rA=r3, rS=r4, uimm. Rc fixed by mnemonic.
D_FORM_LOGIC_IMM = {
    'ANDI.':  28,   # always Rc=1
    'ANDIS.': 29,   # always Rc=1
    'ORI':    24,   # never Rc
    'ORIS':   25,
    'XORI':   26,
    'XORIS':  27,
}

# Compare (X-form): CMP, CMPL.
CMP_X_OPS = {
    'CMP':   0,
    'CMPL': 32,
}

# Compare (D-form): CMPI (signed), CMPLI (unsigned).
CMP_D_OPS = {
    'CMPI':  11,
    'CMPLI': 10,
}

# 5-component rotate-mask (M-form): RLWINM, RLWIMI.
RLW_OPS = {
    'RLWINM': 21,
    'RLWIMI': 20,
}

# ---------------------------------------------------------------------------
# Mnemonic resolver. Returns (instr_word, shape) — shape indicates which
# fields are inputs/expected (so test_diff knows what to compare).
# ---------------------------------------------------------------------------

def encode_for_3op(mnemonic, ra, rb):
    rc = 1 if mnemonic.endswith('.') else 0
    base = mnemonic.rstrip('.')
    oe = 0
    if base.endswith('O'):
        oe = 1
        base = base[:-1]
    if base in ARITH_3_OPS:
        sub_op, _ = ARITH_3_OPS[base]
        return x_arith(sub_op, DEST_REG, SRCA_REG, SRCB_REG, rc=rc, oe=oe)
    if base in LOGIC_3_OPS:
        sub_op = LOGIC_3_OPS[base]
        if oe: return None
        return x_logic(sub_op, DEST_REG, SRCA_REG, SRCB_REG, rc=rc)
    # SRAWI is special: it appears in the oracle with a 3-op format but the
    # "rB" value is actually the SH (shift count) immediate. Encode SH into
    # the bits 11-15 slot using the value from rB.
    if base == 'SRAWI':
        if oe: return None
        sub_op = 824
        sh = rb & 0x1F
        return ((OPCODE_31 << 26) | ((SRCA_REG & 0x1F) << 21) | ((DEST_REG & 0x1F) << 16)
                | ((sh & 0x1F) << 11) | ((sub_op & 0x3FF) << 1) | (rc & 1)) & 0xFFFFFFFF
    return None

def encode_for_2op(mnemonic, ra):
    rc = 1 if mnemonic.endswith('.') else 0
    base = mnemonic.rstrip('.')
    oe = 0
    if base.endswith('O'):
        oe = 1
        base = base[:-1]
    if base in ARITH_2_OPS:
        return x_2op_arith(ARITH_2_OPS[base], DEST_REG, SRCA_REG, rc=rc, oe=oe)
    if base in LOGIC_2_OPS:
        if oe: return None
        return x_2op_logic(LOGIC_2_OPS[base], DEST_REG, SRCA_REG, rc=rc)
    return None

def encode_for_3op_imm(mnemonic, ra, imm):
    base = mnemonic
    if base in D_FORM_IMM:
        return d_form(D_FORM_IMM[base], DEST_REG, SRCA_REG, imm)
    if base in D_FORM_LOGIC_IMM:
        return d_form_logic(D_FORM_LOGIC_IMM[base], DEST_REG, SRCA_REG, imm)
    return None

def encode_for_cmp(mnemonic, ra, rb):
    base = mnemonic
    if base in CMP_X_OPS:
        return x_cmp(CMP_X_OPS[base], SRCA_REG, SRCB_REG, crfd=0, l=0)
    return None

def encode_for_cmp_imm(mnemonic, ra, imm):
    base = mnemonic
    if base in CMP_D_OPS:
        return d_cmp(CMP_D_OPS[base], SRCA_REG, imm, crfd=0, l=0)
    return None

def encode_for_5op(mnemonic, rs, sh, mb, me):
    rc = 1 if mnemonic.endswith('.') else 0
    base = mnemonic.rstrip('.')
    if base in RLW_OPS:
        return m_form_rlw(RLW_OPS[base], DEST_REG, SRCA_REG, sh, mb, me, rc=rc)
    return None

# Line patterns ------------------------------------------------------------

LINE_3OP = re.compile(
    r'^([A-Z_.][A-Z_.0-9]*)\s+::\s+'
    r'rD\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'rA\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'rB\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'XER:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'CR:\s+0x([0-9A-Fa-f]+)\s*$'
)

LINE_2OP = re.compile(
    r'^([A-Z_.][A-Z_.0-9]*)\s+::\s+'
    r'rD\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'rA\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'XER:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'CR:\s+0x([0-9A-Fa-f]+)\s*$'
)

LINE_3OP_IMM = re.compile(
    r'^([A-Z_.][A-Z_.0-9]*)\s+::\s+'
    r'rD\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'rA\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'imm\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'XER:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'CR:\s+0x([0-9A-Fa-f]+)\s*$'
)

LINE_CMP = re.compile(
    r'^([A-Z_.][A-Z_.0-9]*)\s+::\s+'
    r'rA\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'rB\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'XER:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'CR:\s+0x([0-9A-Fa-f]+)\s*$'
)

LINE_CMP_IMM = re.compile(
    r'^([A-Z_.][A-Z_.0-9]*)\s+::\s+'
    r'rA\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'imm\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'XER:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'CR:\s+0x([0-9A-Fa-f]+)\s*$'
)

LINE_5OP = re.compile(
    r'^([A-Z_.][A-Z_.0-9]*)\s+::\s+'
    r'rD\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'rS\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'SH\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'MB:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'ME:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'XER:\s+0x([0-9A-Fa-f]+)\s+\|\s+'
    r'CR:\s+0x([0-9A-Fa-f]+)\s*$'
)

# OracleCase shape constants (must match test_diff.cpp).
SHAPE_3OP, SHAPE_2OP, SHAPE_IMM, SHAPE_CMP, SHAPE_CMP_IMM, SHAPE_5OP = range(6)

def main():
    src = Path('/Users/caseybement/gc_refs/DolphinPPCTests/binary/instruction_tests_console.txt')
    if not src.exists():
        print(f'oracle file not found: {src}', file=sys.stderr)
        sys.exit(1)

    cases = []
    skipped_mnemonics = set()
    skipped_lines = 0
    matched_lines = 0

    with src.open() as f:
        for line in f:
            line = line.rstrip('\n')

            # Try each shape; first match wins. Order matters — 5op before 3op
            # before 2op since some have overlapping prefixes; the regexes
            # anchor end-of-line so length matters.
            m = LINE_5OP.match(line)
            if m:
                matched_lines += 1
                mn  = m.group(1)
                rd  = int(m.group(2), 16)
                rs  = int(m.group(3), 16)
                sh  = int(m.group(4), 16)
                mb  = int(m.group(5), 16)
                me  = int(m.group(6), 16)
                xer = int(m.group(7), 16)
                cr  = int(m.group(8), 16)
                inst = encode_for_5op(mn, rs, sh, mb, me)
                if inst is None:
                    skipped_mnemonics.add(mn); skipped_lines += 1
                    continue
                cases.append((mn, SHAPE_5OP, inst, rs, sh, mb, me, rd, xer, cr))
                continue

            m = LINE_3OP.match(line)
            if m:
                matched_lines += 1
                mn  = m.group(1)
                rd  = int(m.group(2), 16)
                ra  = int(m.group(3), 16)
                rb  = int(m.group(4), 16)
                xer = int(m.group(5), 16)
                cr  = int(m.group(6), 16)
                inst = encode_for_3op(mn, ra, rb)
                if inst is None:
                    skipped_mnemonics.add(mn); skipped_lines += 1
                    continue
                cases.append((mn, SHAPE_3OP, inst, ra, rb, 0, 0, rd, xer, cr))
                continue

            m = LINE_3OP_IMM.match(line)
            if m:
                matched_lines += 1
                mn  = m.group(1)
                rd  = int(m.group(2), 16)
                ra  = int(m.group(3), 16)
                imm = int(m.group(4), 16)
                xer = int(m.group(5), 16)
                cr  = int(m.group(6), 16)
                inst = encode_for_3op_imm(mn, ra, imm)
                if inst is None:
                    skipped_mnemonics.add(mn); skipped_lines += 1
                    continue
                cases.append((mn, SHAPE_IMM, inst, ra, imm, 0, 0, rd, xer, cr))
                continue

            m = LINE_2OP.match(line)
            if m:
                matched_lines += 1
                mn  = m.group(1)
                rd  = int(m.group(2), 16)
                ra  = int(m.group(3), 16)
                xer = int(m.group(4), 16)
                cr  = int(m.group(5), 16)
                inst = encode_for_2op(mn, ra)
                if inst is None:
                    skipped_mnemonics.add(mn); skipped_lines += 1
                    continue
                cases.append((mn, SHAPE_2OP, inst, ra, 0, 0, 0, rd, xer, cr))
                continue

            m = LINE_CMP.match(line)
            if m:
                matched_lines += 1
                mn  = m.group(1)
                ra  = int(m.group(2), 16)
                rb  = int(m.group(3), 16)
                xer = int(m.group(4), 16)
                cr  = int(m.group(5), 16)
                inst = encode_for_cmp(mn, ra, rb)
                if inst is None:
                    skipped_mnemonics.add(mn); skipped_lines += 1
                    continue
                # CMP has no rD output; mark exp_rd = 0 and shape = SHAPE_CMP
                # so test_diff skips the rD comparison.
                cases.append((mn, SHAPE_CMP, inst, ra, rb, 0, 0, 0, xer, cr))
                continue

            m = LINE_CMP_IMM.match(line)
            if m:
                matched_lines += 1
                mn  = m.group(1)
                ra  = int(m.group(2), 16)
                imm = int(m.group(3), 16)
                xer = int(m.group(4), 16)
                cr  = int(m.group(5), 16)
                inst = encode_for_cmp_imm(mn, ra, imm)
                if inst is None:
                    skipped_mnemonics.add(mn); skipped_lines += 1
                    continue
                cases.append((mn, SHAPE_CMP_IMM, inst, ra, imm, 0, 0, 0, xer, cr))
                continue

    out = Path(__file__).resolve().parent.parent / 'tests' / 'oracle_data.h'
    with out.open('w') as f:
        f.write('// Auto-generated by tools/parse_oracle.py from\n')
        f.write('// gc_refs/DolphinPPCTests/binary/instruction_tests_console.txt.\n')
        f.write('// Do not edit by hand — re-run the parser instead.\n')
        f.write('//\n')
        f.write(f'// Cases: {len(cases)} parsed, {skipped_lines} lines skipped (unsupported mnemonic)\n')
        f.write(f'// Skipped mnemonics ({len(skipped_mnemonics)}): {", ".join(sorted(skipped_mnemonics))}\n')
        f.write('//\n')
        f.write('// Shapes:\n')
        f.write('//   SHAPE_3OP     = 0   (rA=r4, rB=r5; expect rD in r3)\n')
        f.write('//   SHAPE_2OP     = 1   (rA=r4;        expect rD in r3)\n')
        f.write('//   SHAPE_IMM     = 2   (rA=r4, imm baked in instr; expect rD in r3)\n')
        f.write('//   SHAPE_CMP     = 3   (rA=r4, rB=r5; no rD — only expect XER+CR)\n')
        f.write('//   SHAPE_CMP_IMM = 4   (rA=r4, imm baked in instr; expect XER+CR)\n')
        f.write('//   SHAPE_5OP     = 5   (rS=r4, SH/MB/ME baked in instr; expect rD in r3)\n')
        f.write('\n')
        f.write('#pragma once\n')
        f.write('#include "bementalJIT/types.h"\n')
        f.write('\n')
        f.write('enum OracleShape : u32 {\n')
        f.write('    OS_3OP = 0, OS_2OP = 1, OS_IMM = 2,\n')
        f.write('    OS_CMP = 3, OS_CMP_IMM = 4, OS_5OP = 5,\n')
        f.write('};\n')
        f.write('\n')
        f.write('struct OracleCase {\n')
        f.write('    const char* name;\n')
        f.write('    u32 shape;\n')
        f.write('    u32 instr_word;\n')
        f.write('    u32 in_a;        // rA value (input)\n')
        f.write('    u32 in_b;        // rB value (input) for 3OP/CMP, or 0\n')
        f.write('    u32 unused1;     // reserved (was for 5op MB)\n')
        f.write('    u32 unused2;     // reserved (was for 5op ME)\n')
        f.write('    u32 exp_rd;      // expected rD (0 for SHAPE_CMP)\n')
        f.write('    u32 exp_xer;\n')
        f.write('    u32 exp_cr;\n')
        f.write('};\n')
        f.write('\n')
        f.write(f'static constexpr OracleCase k_oracle_cases[] = {{\n')
        for (mn, shape, inst, a, b, u1, u2, rd, xer, cr) in cases:
            f.write(f'    {{"{mn}", {shape}, 0x{inst:08x}u, 0x{a:08x}u, 0x{b:08x}u, 0x{u1:08x}u, 0x{u2:08x}u, 0x{rd:08x}u, 0x{xer:08x}u, 0x{cr:08x}u}},\n')
        f.write('};\n')
        f.write('\n')
        f.write(f'static constexpr unsigned k_oracle_case_count = {len(cases)};\n')

    print(f'Wrote {len(cases)} cases to {out}')
    print(f'Matched: {matched_lines}, skipped: {skipped_lines}')
    if skipped_mnemonics:
        print(f'Unsupported mnemonics ({len(skipped_mnemonics)}): {", ".join(sorted(skipped_mnemonics))}')

if __name__ == '__main__':
    main()
