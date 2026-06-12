# Opinfo coverage gap — bementalJIT vs Dolphin

## Summary

| Status | Count |
|---|---|
| PRESENT | 202 (184 original + 18 closed 2026-06-10) |
| PRESENT_FLAG_MISMATCH | 35 |
| MISSING (reachable) | 0 |
| MISSING (unreachable / paired-singles) | 0 |
| INTENTIONALLY_SKIPPED | 0 |
| **Total Dolphin entries (excl Invalid/Subtable)** | 237 |

## Coverage table

| opcode (primary.sub) | Dolphin name | OpType | Reachable | Status |
|---|---|---|---|---|
| 3 (primary) | `twi` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 4.0 (sub10) | `ps_cmpu0` | PS | ✗ | PRESENT |
| 4.32 (sub10) | `ps_cmpo0` | PS | ✗ | PRESENT |
| 4.40 (sub10) | `ps_neg` | PS | ✗ | PRESENT |
| 4.64 (sub10) | `ps_cmpu1` | PS | ✗ | PRESENT |
| 4.72 (sub10) | `ps_mr` | PS | ✗ | PRESENT |
| 4.96 (sub10) | `ps_cmpo1` | PS | ✗ | PRESENT |
| 4.136 (sub10) | `ps_nabs` | PS | ✗ | PRESENT |
| 4.264 (sub10) | `ps_abs` | PS | ✗ | PRESENT |
| 4.528 (sub10) | `ps_merge00` | PS | ✗ | PRESENT |
| 4.560 (sub10) | `ps_merge01` | PS | ✗ | PRESENT |
| 4.592 (sub10) | `ps_merge10` | PS | ✗ | PRESENT |
| 4.624 (sub10) | `ps_merge11` | PS | ✗ | PRESENT |
| 4.1014 (sub10) | `dcbz_l` | System | ✓ | PRESENT |
| 4.10 (sub5) | `ps_sum0` | PS | ✗ | PRESENT |
| 4.11 (sub5) | `ps_sum1` | PS | ✗ | PRESENT |
| 4.12 (sub5) | `ps_muls0` | PS | ✗ | PRESENT |
| 4.13 (sub5) | `ps_muls1` | PS | ✗ | PRESENT |
| 4.14 (sub5) | `ps_madds0` | PS | ✗ | PRESENT |
| 4.15 (sub5) | `ps_madds1` | PS | ✗ | PRESENT |
| 4.18 (sub5) | `ps_div` | PS | ✗ | PRESENT |
| 4.20 (sub5) | `ps_sub` | PS | ✗ | PRESENT |
| 4.21 (sub5) | `ps_add` | PS | ✗ | PRESENT |
| 4.23 (sub5) | `ps_sel` | PS | ✗ | PRESENT |
| 4.24 (sub5) | `ps_res` | PS | ✗ | PRESENT |
| 4.25 (sub5) | `ps_mul` | PS | ✗ | PRESENT |
| 4.26 (sub5) | `ps_rsqrte` | PS | ✗ | PRESENT |
| 4.28 (sub5) | `ps_msub` | PS | ✗ | PRESENT |
| 4.29 (sub5) | `ps_madd` | PS | ✗ | PRESENT |
| 4.30 (sub5) | `ps_nmsub` | PS | ✗ | PRESENT |
| 4.31 (sub5) | `ps_nmadd` | PS | ✗ | PRESENT |
| 4.6 (sub6) | `psq_lx` | LoadPS | ✗ | PRESENT |
| 4.7 (sub6) | `psq_stx` | StorePS | ✗ | PRESENT |
| 4.38 (sub6) | `psq_lux` | LoadPS | ✗ | PRESENT |
| 4.39 (sub6) | `psq_stux` | StorePS | ✗ | PRESENT |
| 7 (primary) | `mulli` | Integer | ✓ | PRESENT |
| 8 (primary) | `subfic` | Integer | ✓ | PRESENT |
| 10 (primary) | `cmpli` | Integer | ✓ | PRESENT |
| 11 (primary) | `cmpi` | Integer | ✓ | PRESENT |
| 12 (primary) | `addic` | Integer | ✓ | PRESENT |
| 13 (primary) | `addic_rc` | Integer | ✓ | PRESENT |
| 14 (primary) | `addi` | Integer | ✓ | PRESENT |
| 15 (primary) | `addis` | Integer | ✓ | PRESENT |
| 16 (primary) | `bcx` | Branch | ✓ | PRESENT |
| 17 (primary) | `sc` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 18 (primary) | `bx` | Branch | ✓ | PRESENT |
| 19.0 (sub10) | `mcrf` | System | ✓ | PRESENT |
| 19.16 (sub10) | `bclrx` | Branch | ✓ | PRESENT |
| 19.33 (sub10) | `crnor` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.50 (sub10) | `rfi` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 19.129 (sub10) | `crandc` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.150 (sub10) | `isync` | InstructionCache | ✓ | PRESENT_FLAG_MISMATCH |
| 19.193 (sub10) | `crxor` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.225 (sub10) | `crnand` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.257 (sub10) | `crand` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.289 (sub10) | `creqv` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.417 (sub10) | `crorc` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.449 (sub10) | `cror` | CR | ✓ | PRESENT_FLAG_MISMATCH |
| 19.528 (sub10) | `bcctrx` | Branch | ✓ | PRESENT |
| 20 (primary) | `rlwimix` | Integer | ✓ | PRESENT |
| 21 (primary) | `rlwinmx` | Integer | ✓ | PRESENT |
| 23 (primary) | `rlwnmx` | Integer | ✓ | PRESENT |
| 24 (primary) | `ori` | Integer | ✓ | PRESENT |
| 25 (primary) | `oris` | Integer | ✓ | PRESENT |
| 26 (primary) | `xori` | Integer | ✓ | PRESENT |
| 27 (primary) | `xoris` | Integer | ✓ | PRESENT |
| 28 (primary) | `andi_rc` | Integer | ✓ | PRESENT |
| 29 (primary) | `andis_rc` | Integer | ✓ | PRESENT |
| 31.0 (sub10) | `cmp` | Integer | ✓ | PRESENT |
| 31.4 (sub10) | `tw` | System | ✓ | PRESENT (closed 2026-06-10) |
| 31.8 (sub10) | `subfcx` | Integer | ✓ | PRESENT |
| 31.10 (sub10) | `addcx` | Integer | ✓ | PRESENT |
| 31.11 (sub10) | `mulhwux` | Integer | ✓ | PRESENT |
| 31.19 (sub10) | `mfcr` | System | ✓ | PRESENT |
| 31.20 (sub10) | `lwarx` | Load | ✓ | PRESENT (closed 2026-06-10) |
| 31.23 (sub10) | `lwzx` | Load | ✓ | PRESENT |
| 31.24 (sub10) | `slwx` | Integer | ✓ | PRESENT |
| 31.26 (sub10) | `cntlzwx` | Integer | ✓ | PRESENT |
| 31.28 (sub10) | `andx` | Integer | ✓ | PRESENT |
| 31.32 (sub10) | `cmpl` | Integer | ✓ | PRESENT |
| 31.40 (sub10) | `subfx` | Integer | ✓ | PRESENT |
| 31.54 (sub10) | `dcbst` | DataCache | ✓ | PRESENT_FLAG_MISMATCH |
| 31.55 (sub10) | `lwzux` | Load | ✓ | PRESENT |
| 31.60 (sub10) | `andcx` | Integer | ✓ | PRESENT |
| 31.75 (sub10) | `mulhwx` | Integer | ✓ | PRESENT |
| 31.83 (sub10) | `mfmsr` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 31.86 (sub10) | `dcbf` | DataCache | ✓ | PRESENT_FLAG_MISMATCH |
| 31.87 (sub10) | `lbzx` | Load | ✓ | PRESENT |
| 31.104 (sub10) | `negx` | Integer | ✓ | PRESENT |
| 31.119 (sub10) | `lbzux` | Load | ✓ | PRESENT |
| 31.124 (sub10) | `norx` | Integer | ✓ | PRESENT |
| 31.136 (sub10) | `subfex` | Integer | ✓ | PRESENT |
| 31.138 (sub10) | `addex` | Integer | ✓ | PRESENT |
| 31.144 (sub10) | `mtcrf` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 31.146 (sub10) | `mtmsr` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 31.150 (sub10) | `stwcxd` | Store | ✓ | PRESENT (closed 2026-06-10) |
| 31.151 (sub10) | `stwx` | Store | ✓ | PRESENT |
| 31.183 (sub10) | `stwux` | Store | ✓ | PRESENT |
| 31.200 (sub10) | `subfzex` | Integer | ✓ | PRESENT |
| 31.202 (sub10) | `addzex` | Integer | ✓ | PRESENT |
| 31.210 (sub10) | `mtsr` | System | ✓ | PRESENT |
| 31.215 (sub10) | `stbx` | Store | ✓ | PRESENT |
| 31.232 (sub10) | `subfmex` | Integer | ✓ | PRESENT |
| 31.234 (sub10) | `addmex` | Integer | ✓ | PRESENT |
| 31.235 (sub10) | `mullwx` | Integer | ✓ | PRESENT |
| 31.242 (sub10) | `mtsrin` | System | ✓ | PRESENT |
| 31.246 (sub10) | `dcbtst` | DataCache | ✓ | PRESENT |
| 31.247 (sub10) | `stbux` | Store | ✓ | PRESENT |
| 31.266 (sub10) | `addx` | Integer | ✓ | PRESENT |
| 31.278 (sub10) | `dcbt` | DataCache | ✓ | PRESENT |
| 31.279 (sub10) | `lhzx` | Load | ✓ | PRESENT |
| 31.284 (sub10) | `eqvx` | Integer | ✓ | PRESENT |
| 31.306 (sub10) | `tlbie` | System | ✓ | PRESENT |
| 31.310 (sub10) | `eciwx` | System | ✓ | PRESENT (closed 2026-06-10) |
| 31.311 (sub10) | `lhzux` | Load | ✓ | PRESENT |
| 31.316 (sub10) | `xorx` | Integer | ✓ | PRESENT |
| 31.339 (sub10) | `mfspr` | SPR | ✓ | PRESENT_FLAG_MISMATCH |
| 31.343 (sub10) | `lhax` | Load | ✓ | PRESENT |
| 31.371 (sub10) | `mftb` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 31.375 (sub10) | `lhaux` | Load | ✓ | PRESENT |
| 31.407 (sub10) | `sthx` | Store | ✓ | PRESENT |
| 31.412 (sub10) | `orcx` | Integer | ✓ | PRESENT |
| 31.438 (sub10) | `ecowx` | System | ✓ | PRESENT (closed 2026-06-10) |
| 31.439 (sub10) | `sthux` | Store | ✓ | PRESENT |
| 31.444 (sub10) | `orx` | Integer | ✓ | PRESENT |
| 31.459 (sub10) | `divwux` | Integer | ✓ | PRESENT_FLAG_MISMATCH |
| 31.467 (sub10) | `mtspr` | SPR | ✓ | PRESENT_FLAG_MISMATCH |
| 31.470 (sub10) | `dcbi` | DataCache | ✓ | PRESENT_FLAG_MISMATCH |
| 31.476 (sub10) | `nandx` | Integer | ✓ | PRESENT |
| 31.491 (sub10) | `divwx` | Integer | ✓ | PRESENT_FLAG_MISMATCH |
| 31.512 (sub10) | `mcrxr` | System | ✓ | PRESENT (closed 2026-06-10) |
| 31.520 (sub10) | `subfcox` | Integer | ✓ | PRESENT |
| 31.522 (sub10) | `addcox` | Integer | ✓ | PRESENT |
| 31.533 (sub10) | `lswx` | Load | ✓ | PRESENT (closed 2026-06-10) |
| 31.534 (sub10) | `lwbrx` | Load | ✓ | PRESENT |
| 31.535 (sub10) | `lfsx` | LoadFP | ✓ | PRESENT |
| 31.536 (sub10) | `srwx` | Integer | ✓ | PRESENT |
| 31.552 (sub10) | `subfox` | Integer | ✓ | PRESENT |
| 31.566 (sub10) | `tlbsync` | System | ✓ | PRESENT (closed 2026-06-10) |
| 31.567 (sub10) | `lfsux` | LoadFP | ✓ | PRESENT (closed 2026-06-10) |
| 31.595 (sub10) | `mfsr` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 31.597 (sub10) | `lswi` | Load | ✓ | PRESENT (closed 2026-06-10) |
| 31.598 (sub10) | `sync` | System | ✓ | PRESENT |
| 31.599 (sub10) | `lfdx` | LoadFP | ✓ | PRESENT (closed 2026-06-10) |
| 31.616 (sub10) | `negox` | Integer | ✓ | PRESENT |
| 31.631 (sub10) | `lfdux` | LoadFP | ✓ | PRESENT (closed 2026-06-10) |
| 31.648 (sub10) | `subfeox` | Integer | ✓ | PRESENT |
| 31.650 (sub10) | `addeox` | Integer | ✓ | PRESENT |
| 31.659 (sub10) | `mfsrin` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 31.661 (sub10) | `stswx` | Store | ✓ | PRESENT (closed 2026-06-10) |
| 31.662 (sub10) | `stwbrx` | Store | ✓ | PRESENT |
| 31.663 (sub10) | `stfsx` | StoreFP | ✓ | PRESENT |
| 31.695 (sub10) | `stfsux` | StoreFP | ✓ | PRESENT (closed 2026-06-10) |
| 31.712 (sub10) | `subfzeox` | Integer | ✓ | PRESENT |
| 31.714 (sub10) | `addzeox` | Integer | ✓ | PRESENT |
| 31.725 (sub10) | `stswi` | Store | ✓ | PRESENT (closed 2026-06-10) |
| 31.727 (sub10) | `stfdx` | StoreFP | ✓ | PRESENT (closed 2026-06-10) |
| 31.744 (sub10) | `subfmeox` | Integer | ✓ | PRESENT |
| 31.746 (sub10) | `addmeox` | Integer | ✓ | PRESENT |
| 31.747 (sub10) | `mullwox` | Integer | ✓ | PRESENT |
| 31.758 (sub10) | `dcba` | DataCache | ✓ | PRESENT (closed 2026-06-10) |
| 31.759 (sub10) | `stfdux` | StoreFP | ✓ | PRESENT (closed 2026-06-10) |
| 31.778 (sub10) | `addox` | Integer | ✓ | PRESENT |
| 31.790 (sub10) | `lhbrx` | Load | ✓ | PRESENT |
| 31.792 (sub10) | `srawx` | Integer | ✓ | PRESENT |
| 31.824 (sub10) | `srawix` | Integer | ✓ | PRESENT |
| 31.854 (sub10) | `eieio` | System | ✓ | PRESENT |
| 31.918 (sub10) | `sthbrx` | Store | ✓ | PRESENT |
| 31.922 (sub10) | `extshx` | Integer | ✓ | PRESENT |
| 31.954 (sub10) | `extsbx` | Integer | ✓ | PRESENT |
| 31.971 (sub10) | `divwuox` | Integer | ✓ | PRESENT_FLAG_MISMATCH |
| 31.982 (sub10) | `icbi` | System | ✓ | PRESENT_FLAG_MISMATCH |
| 31.983 (sub10) | `stfiwx` | StoreFP | ✓ | PRESENT |
| 31.1003 (sub10) | `divwox` | Integer | ✓ | PRESENT_FLAG_MISMATCH |
| 31.1014 (sub10) | `dcbz` | DataCache | ✓ | PRESENT |
| 32 (primary) | `lwz` | Load | ✓ | PRESENT |
| 33 (primary) | `lwzu` | Load | ✓ | PRESENT |
| 34 (primary) | `lbz` | Load | ✓ | PRESENT |
| 35 (primary) | `lbzu` | Load | ✓ | PRESENT |
| 36 (primary) | `stw` | Store | ✓ | PRESENT |
| 37 (primary) | `stwu` | Store | ✓ | PRESENT |
| 38 (primary) | `stb` | Store | ✓ | PRESENT |
| 39 (primary) | `stbu` | Store | ✓ | PRESENT |
| 40 (primary) | `lhz` | Load | ✓ | PRESENT |
| 41 (primary) | `lhzu` | Load | ✓ | PRESENT |
| 42 (primary) | `lha` | Load | ✓ | PRESENT |
| 43 (primary) | `lhau` | Load | ✓ | PRESENT |
| 44 (primary) | `sth` | Store | ✓ | PRESENT |
| 45 (primary) | `sthu` | Store | ✓ | PRESENT |
| 46 (primary) | `lmw` | System | ✓ | PRESENT |
| 47 (primary) | `stmw` | System | ✓ | PRESENT |
| 48 (primary) | `lfs` | LoadFP | ✓ | PRESENT_FLAG_MISMATCH |
| 49 (primary) | `lfsu` | LoadFP | ✓ | PRESENT |
| 50 (primary) | `lfd` | LoadFP | ✓ | PRESENT_FLAG_MISMATCH |
| 51 (primary) | `lfdu` | LoadFP | ✓ | PRESENT_FLAG_MISMATCH |
| 52 (primary) | `stfs` | StoreFP | ✓ | PRESENT |
| 53 (primary) | `stfsu` | StoreFP | ✓ | PRESENT |
| 54 (primary) | `stfd` | StoreFP | ✓ | PRESENT |
| 55 (primary) | `stfdu` | StoreFP | ✓ | PRESENT |
| 56 (primary) | `psq_l` | LoadPS | ✗ | PRESENT_FLAG_MISMATCH |
| 57 (primary) | `psq_lu` | LoadPS | ✗ | PRESENT_FLAG_MISMATCH |
| 59.18 (sub5) | `fdivsx` | SingleFP | ✓ | PRESENT |
| 59.20 (sub5) | `fsubsx` | SingleFP | ✓ | PRESENT |
| 59.21 (sub5) | `faddsx` | SingleFP | ✓ | PRESENT |
| 59.24 (sub5) | `fresx` | SingleFP | ✓ | PRESENT |
| 59.25 (sub5) | `fmulsx` | SingleFP | ✓ | PRESENT |
| 59.28 (sub5) | `fmsubsx` | SingleFP | ✓ | PRESENT |
| 59.29 (sub5) | `fmaddsx` | SingleFP | ✓ | PRESENT |
| 59.30 (sub5) | `fnmsubsx` | SingleFP | ✓ | PRESENT |
| 59.31 (sub5) | `fnmaddsx` | SingleFP | ✓ | PRESENT |
| 60 (primary) | `psq_st` | StorePS | ✗ | PRESENT_FLAG_MISMATCH |
| 61 (primary) | `psq_stu` | StorePS | ✗ | PRESENT_FLAG_MISMATCH |
| 63.0 (sub10) | `fcmpu` | DoubleFP | ✓ | PRESENT |
| 63.12 (sub10) | `frspx` | DoubleFP | ✓ | PRESENT |
| 63.14 (sub10) | `fctiwx` | DoubleFP | ✓ | PRESENT |
| 63.15 (sub10) | `fctiwzx` | DoubleFP | ✓ | PRESENT |
| 63.32 (sub10) | `fcmpo` | DoubleFP | ✓ | PRESENT |
| 63.38 (sub10) | `mtfsb1x` | SystemFP | ✓ | PRESENT |
| 63.40 (sub10) | `fnegx` | DoubleFP | ✓ | PRESENT |
| 63.64 (sub10) | `mcrfs` | SystemFP | ✓ | PRESENT |
| 63.70 (sub10) | `mtfsb0x` | SystemFP | ✓ | PRESENT |
| 63.72 (sub10) | `fmrx` | DoubleFP | ✓ | PRESENT |
| 63.134 (sub10) | `mtfsfix` | SystemFP | ✓ | PRESENT |
| 63.136 (sub10) | `fnabsx` | DoubleFP | ✓ | PRESENT |
| 63.264 (sub10) | `fabsx` | DoubleFP | ✓ | PRESENT |
| 63.583 (sub10) | `mffsx` | SystemFP | ✓ | PRESENT |
| 63.711 (sub10) | `mtfsfx` | SystemFP | ✓ | PRESENT |
| 63.18 (sub5) | `fdivx` | DoubleFP | ✓ | PRESENT |
| 63.20 (sub5) | `fsubx` | DoubleFP | ✓ | PRESENT |
| 63.21 (sub5) | `faddx` | DoubleFP | ✓ | PRESENT |
| 63.23 (sub5) | `fselx` | DoubleFP | ✓ | PRESENT |
| 63.25 (sub5) | `fmulx` | DoubleFP | ✓ | PRESENT |
| 63.26 (sub5) | `frsqrtex` | DoubleFP | ✓ | PRESENT |
| 63.28 (sub5) | `fmsubx` | DoubleFP | ✓ | PRESENT |
| 63.29 (sub5) | `fmaddx` | DoubleFP | ✓ | PRESENT |
| 63.30 (sub5) | `fnmsubx` | DoubleFP | ✓ | PRESENT |
| 63.31 (sub5) | `fnmaddx` | DoubleFP | ✓ | PRESENT |

## MISSING reachable — CLOSED 2026-06-10

All 18 entries below were added to `gamecube/bementalJIT/guests/powerpc-next/ppc_tables.cpp` (verified live at lines 273–308: every name resolves to a `GekkoOPInfo` definition). Probe evidence: 60s `dolphin_render_probe.js` post-patch, 0 new `block broken` markers; PC-count delta verdict NOISE (698/699/701 vs 706 baseline — see STATUS.md "Task-1 variance check"). Table kept as the historical insertion list:

| opcode (primary.sub) | Dolphin name | Insertion table |
|---|---|---|
| 31.4 (sub10) | `tw` | `table31` |
| 31.20 (sub10) | `lwarx` | `table31` |
| 31.150 (sub10) | `stwcxd` | `table31` |
| 31.310 (sub10) | `eciwx` | `table31` |
| 31.438 (sub10) | `ecowx` | `table31` |
| 31.512 (sub10) | `mcrxr` | `table31` |
| 31.533 (sub10) | `lswx` | `table31` |
| 31.566 (sub10) | `tlbsync` | `table31` |
| 31.567 (sub10) | `lfsux` | `table31` |
| 31.597 (sub10) | `lswi` | `table31` |
| 31.599 (sub10) | `lfdx` | `table31` |
| 31.631 (sub10) | `lfdux` | `table31` |
| 31.661 (sub10) | `stswx` | `table31` |
| 31.695 (sub10) | `stfsux` | `table31` |
| 31.725 (sub10) | `stswi` | `table31` |
| 31.727 (sub10) | `stfdx` | `table31` |
| 31.758 (sub10) | `dcba` | `table31` |
| 31.759 (sub10) | `stfdux` | `table31` |

## PRESENT_FLAG_MISMATCH (human review)

Patcher does not touch these — flag deltas require manual review.

| opcode (primary.sub) | Dolphin name | Severity | Dolphin flags | bementalJIT flags |
|---|---|---|---|---|
| 3 (primary) | `twi` | semantic | FL_IN_A \| FL_ENDBLOCK | FL_IN_A \| FL_PROGRAMEXCEPTION \| FL_ENDBLOCK |
| 17 (primary) | `sc` | semantic | FL_ENDBLOCK | FL_ENDBLOCK \| FL_PROGRAMEXCEPTION |
| 19.33 (sub10) | `crnor` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 19.50 (sub10) | `rfi` | semantic | FL_ENDBLOCK \| FL_CHECKEXCEPTIONS \| FL_PROGRAMEXCEPTION \| FL_SET_MSR | FL_ENDBLOCK \| FL_SET_MSR \| FL_CHECKEXCEPTIONS |
| 19.129 (sub10) | `crandc` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 19.150 (sub10) | `isync` | cosmetic | FL_NO_REORDER | (none) |
| 19.193 (sub10) | `crxor` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 19.225 (sub10) | `crnand` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 19.257 (sub10) | `crand` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 19.289 (sub10) | `creqv` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 19.417 (sub10) | `crorc` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 19.449 (sub10) | `cror` | semantic | (none) | FL_READ_ALL_CR \| FL_SET_ALL_CR |
| 31.54 (sub10) | `dcbst` | semantic | FL_IN_A0 \| FL_IN_B \| FL_LOADSTORE | (none) |
| 31.83 (sub10) | `mfmsr` | semantic | FL_OUT_D \| FL_PROGRAMEXCEPTION | FL_OUT_D |
| 31.86 (sub10) | `dcbf` | semantic | FL_IN_A0 \| FL_IN_B \| FL_LOADSTORE | (none) |
| 31.144 (sub10) | `mtcrf` | semantic | FL_IN_S \| FL_SET_ALL_CR \| FL_READ_ALL_CR | FL_IN_S \| FL_SET_CR0 \| FL_SET_CR1 \| FL_SET_CRn \| FL_SET_ALL_CR |
| 31.146 (sub10) | `mtmsr` | semantic | FL_IN_S \| FL_ENDBLOCK \| FL_PROGRAMEXCEPTION \| FL_FLOAT_EXCEPTION \| FL_SET_MSR | FL_IN_S \| FL_SET_MSR \| FL_ENDBLOCK \| FL_CHECKEXCEPTIONS |
| 31.339 (sub10) | `mfspr` | semantic | FL_OUT_D \| FL_PROGRAMEXCEPTION | FL_OUT_D |
| 31.371 (sub10) | `mftb` | semantic | FL_OUT_D \| FL_TIMER \| FL_PROGRAMEXCEPTION | FL_OUT_D \| FL_TIMER |
| 31.459 (sub10) | `divwux` | semantic | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT \| FL_FLOAT_DIV |
| 31.467 (sub10) | `mtspr` | semantic | FL_IN_S \| FL_ENDBLOCK \| FL_PROGRAMEXCEPTION | FL_IN_S \| FL_PROGRAMEXCEPTION |
| 31.470 (sub10) | `dcbi` | semantic | FL_IN_A0 \| FL_IN_B \| FL_LOADSTORE \| FL_PROGRAMEXCEPTION | (none) |
| 31.491 (sub10) | `divwx` | semantic | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT \| FL_FLOAT_DIV |
| 31.595 (sub10) | `mfsr` | semantic | FL_OUT_D \| FL_PROGRAMEXCEPTION | FL_OUT_D |
| 31.659 (sub10) | `mfsrin` | semantic | FL_OUT_D \| FL_IN_B \| FL_PROGRAMEXCEPTION | FL_OUT_D \| FL_IN_B |
| 31.971 (sub10) | `divwuox` | semantic | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT \| FL_SET_OE | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT \| FL_FLOAT_DIV \| FL_SET_OE |
| 31.982 (sub10) | `icbi` | semantic | FL_IN_A0 \| FL_IN_B \| FL_ENDBLOCK \| FL_LOADSTORE | (none) |
| 31.1003 (sub10) | `divwox` | semantic | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT \| FL_SET_OE | FL_OUT_D \| FL_IN_A \| FL_IN_B \| FL_RC_BIT \| FL_FLOAT_DIV \| FL_SET_OE |
| 48 (primary) | `lfs` | semantic | FL_OUT_FLOAT_D \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE | FL_OUT_FLOAT_D \| FL_IN_A0 \| FL_USE_FPU \| FL_LOADSTORE |
| 50 (primary) | `lfd` | semantic | FL_IN_FLOAT_D \| FL_OUT_FLOAT_D \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE | FL_OUT_FLOAT_D \| FL_IN_A0 \| FL_USE_FPU \| FL_LOADSTORE |
| 51 (primary) | `lfdu` | semantic | FL_IN_FLOAT_D \| FL_OUT_FLOAT_D \| FL_OUT_A \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE | FL_OUT_FLOAT_D \| FL_OUT_A \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE |
| 56 (primary) | `psq_l` | semantic | FL_OUT_FLOAT_D \| FL_IN_A0 \| FL_USE_FPU \| FL_LOADSTORE \| FL_PROGRAMEXCEPTION | FL_OUT_FLOAT_D \| FL_IN_A0 \| FL_USE_FPU \| FL_LOADSTORE |
| 57 (primary) | `psq_lu` | semantic | FL_OUT_FLOAT_D \| FL_OUT_A \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE \| FL_PROGRAMEXCEPTION | FL_OUT_FLOAT_D \| FL_OUT_A \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE |
| 60 (primary) | `psq_st` | semantic | FL_IN_FLOAT_S \| FL_IN_A0 \| FL_USE_FPU \| FL_LOADSTORE \| FL_PROGRAMEXCEPTION | FL_IN_FLOAT_S \| FL_IN_A0 \| FL_USE_FPU \| FL_LOADSTORE |
| 61 (primary) | `psq_stu` | semantic | FL_IN_FLOAT_S \| FL_OUT_A \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE \| FL_PROGRAMEXCEPTION | FL_IN_FLOAT_S \| FL_OUT_A \| FL_IN_A \| FL_USE_FPU \| FL_LOADSTORE |

## INTENTIONALLY_SKIPPED

_Rule: entries documented in this codebase as deliberately omitted from bementalJIT opinfo coverage. None at this revision._

---
> Generated by gamecube opinfo-audit workflow (Phase C1).
