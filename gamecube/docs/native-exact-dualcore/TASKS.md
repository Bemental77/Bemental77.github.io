# Native-exact dual-core — deviation inventory & strip list

**PM58 2026-08-05 — REGION-SCOPE CR LIVENESS investigated to substrate = ARCHITECTURALLY
CAPPED (earned finding, cited; NOT built — the sound-subset is already shipped, the rest
is exception-unsound).** After PM57's per-block fusion wash, traced the region tier to
decide whether the research's "missing layer" (region-scope CR liveness) is buildable
here. Findings: (1) the research premise — region = ONE compilation unit, CR stays in
locals, never crosses a boundary — maps to the MERGED single-function region shape, which
is DISABLED (block_cache.cpp:1694, s_merged_enabled=false) because it "lost three A/Bs"
(PM53e: the giant-fn br_table measured WORSE than N-fn). (2) The LIVE shape is N-fn (N
separate per-block wasm functions) → CR crosses fn boundaries via PowerPCState memory →
the "one unit" premise doesn't hold. (3) The SOUND cross-block CR elision achievable in
N-fn = intra-run stream liveness, and it is ALREADY SHIPPED via run-fusion v2/v3
(emit_block_body_next → AnalyzeOps runs the reverse-scan liveness across the concatenated
run's original block boundaries, respecting the exception/may_exit resets) — measured
WASH/+3%-noise on SAB (tasks #10/#11). (4) Cross-run/boundary CR elision is exception-
UNSOUND: block/run boundaries are exception-delivery points where the guest handler reads
architectural CR (mfcr context-save); ppc_analyst.cpp:611-621 documents that an elided
store "leaves the handler reading STALE architectural state." Eliding CR dead across a
boundary corrupts the handler's saved context on any async interrupt — a rendering probe
cannot validate against that, so it must not ship. Sound cross-boundary elision needs a
side-exit that RESTORES CR (deopt/rematerialization) — the original research's finding #3:
does NOT fit our per-block-module wasm (no owned exit / no wasm OSR). NET: the CR-elision
family is capped — per-block = redundant with TurboFan DCE (PM57 wash), intra-run =
shipped (run-fusion, wash), cross-run = unsound-without-deopt or needs the disabled merged
shape. Every sound point built/shipped and measured wash. PIVOT to orthogonal researched
levers that hit DIFFERENT bottlenecks (not DCE-redundant, not exception-bound): branch
hints (M136+, task #17) and preload/warmup (task #4). (task #16)**

**PM57 2026-08-04 — ADJACENT cmp→branch FUSION BUILT + MEASURED = WASH; reverted
to eager (BEM_LAZY_CR=false); code+tests kept for the structural region-liveness
follow-up.** Implemented the full PM56 "the win" pairing: a compile-time CmpFuse
peephole (cr_shadow.h) set by the 4 deferring cmp emitters and consumed by
emit_crbit_fused (jit_branch.cpp) — a direct operand-local compare (lt_s/lt_u/
gt_s/gt_u/eq per form) threaded through BOTH emit_bcx (terminal + forward-mid-
block arms) AND emit_bcx_fused (the IDCT self-loop terminal), with age-gated
adjacency invalidation in emit_block_body_into (valid only for the op immediately
after the cmp; a later cmp refreshes age=0). Soundness is trivial given the
preg→wasm-local IDENTITY map (reg_cache.h:62, local_idx=base+preg) + Bind(Read)
guaranteeing the local holds the runtime value — reading fuse->a_local one op
later is valid; adjacency guards any intervening writer. CORRECT: test_diff_next
3457/0 with BEM_LAZY_CR=true (the deferred→materialized reconstruction still
validates bit-for-bit vs the DolphinPPCTests oracle); new lazycr_fused_adjacent
(26 operand vectors incl. signed/unsigned sign boundaries × LT/GT/EQ × both
polarities, differential vs a C++ ISA oracle) + cross-block + SO-freeze +
fused_intloop all green → test_gekko_next 80/0. MEASURED (SAB same-session A/B,
120s presentN steady, last-3-avg per 20s snap): **default tiering (the page-fps
metric) ON {331,301}≈316 vs eager {324,312}≈318 = WASH, ranges fully overlap;
--no-liftoff (deterministic, low-noise) ON ≈303-314 vs eager ≈315 (rock-stable) =
neutral-to-slightly-negative.** Across BOTH metrics ON ≤ OFF — the fusion RECOVERS
the PM56 lazy-CR-alone ~4% regression to eager parity but NEVER wins. MECHANISM:
the redundant eager CR-field build the fusion removes is ALREADY dead-code-
eliminated by TurboFan on hot (steady-state-dominant) code — the hand-fusion just
duplicates V8's own DCE, so it washes out under real tiering. Also characterized
the rig: SAB presentN has ~10% per-boot nondeterminism (331 vs 300 on identical
ON builds) that swamps sub-5% effects; --no-liftoff is the low-noise (±1)
attribution instrument. Reverted per ship-only-measured-wins. Kept: the whole
lazy-CR foundation + CmpFuse + 4 tests + the plan doc
(lazy-cr-and-warmup-implementation-plan.md) for Phase B region-scope CR liveness,
where the elision is PROVABLE-DEAD across a sealed region (not redundant-with-DCE)
— the one context where killing the CR build should actually pay. (task #15)**

**PM56 2026-08-04 — LAZY-CR (deferred flags, QEMU cc_op) IMPLEMENTED, PROVEN
SOUND, but MEASURED net-negative on SAB → gated OFF; the cross-block soundness
blocker is SOLVED, the standalone form isn't the win.** The deep-research
architecture (wf_35a63c0e: deopt-recover needs an owned exit our per-block wasm
lacks; the fitting layers are lazy-flags + region-scope) was built in full,
representation B (shadow + pending, since A = full-canonical-deferred is ruled
out by no-Dolphin-patching — ~15 host CR readers in Dolphin's Interpreter; wf_
6a1c99de). STAGE 1 (cmp producers → deferred shadow store; emit_crbit_test
pending-check + inline materialize) + STAGE 6a (all 28 Rc-form CR0 producers
defer via the one emit_cr0_from_local funnel): CORRECT + SOUND — test_diff_next
3457/0 (the CMP/Rc differential validates the deferred→materialized
reconstruction vs the oracle bit-for-bit), + new lazycr_cross_block_beq (block A
defers CR0, separate block B reads it — the no-liveness/no-guard soundness proof)
+ lazycr_so_freeze (frozen XER.SO byte). Host settle = ONE funnel
(bem_materialize_pending_cr before SingleStepInner in dolphin_interp — every
CR-consuming op falls back there) + savestate (dormant). MEASURED (page metric,
2 runs each): pair = SAB ~313-314/snap vs the ~316-327 pre-lazy band = consistent
~4% REGRESSION; MP4 gc 6699 parity. CAUSE (precise): once every producer defers,
each conditional branch takes the heavier runtime materialize path (pending-check
+ tag-switch) instead of the old 3-op eager read — the consumer tax exceeds the
producer savings on this branch-heavy workload. Per discipline (regressions don't
ship): gated behind BEM_LAZY_CR=false (cr_shadow.h) — byte-identical to pre-PM56
eager. The WIN needs the compile-time ADJACENT cmp→branch fusion: the branch
consuming the immediately-preceding cmp reads its operand LOCALS directly
(bypassing pending-check AND shadow), sound because the shadow+pending backs only
the cross-block readers — the QEMU-cc_op-for-cross-block + peephole-fusion-for-
hot-path combination. Foundation + 3 tests KEPT for that follow-up (task #15).**

**PM55d 2026-08-04 — compact-branch-decode = ALREADY DONE (verified); cmp→branch
CR-encode fusion = SOUNDNESS-BLOCKED, NOT shipped.** (1) VERIFIED against the live
wat (sab_sched.wat:552-554): the branch DECODE is already the compact
`i32.load offset=672; eqz; eqz` (3 ops) via emit_crbit_test — the attribution
agent's "reads whole u64" was WRONG; nothing to reclaim on decode (done in the
fusion-era emit_bcx refactor). (2) The real fat is the cmp CR-ENCODE (~30 ops
building the u64 field, cr_encode.cpp emit_cr_from_*_pair). Design workflow
(wf_1e20dc39, 3 readers) produced the full predicate table + plumbing + an
exhaustive differential test — BUT found the fusion is UNSOUND without a new
analyzer capability: the premise's branch.crDiscardable[n] DOES NOT EXIST
(branches produce no crOut; ppc_analyst.cpp:608 masks crDiscardable by crOut, and
:635 force-resets cr_live_after=0xFF at any block-ending op, so a cmp before a
branch NEVER sees its CR discardable). The analyzer has NO cross-block/successor
CR liveness, so we CANNOT prove CR[crfd] dead after the branch — a successor
block reading CR[crfd] (cror/mfcr/second branch on the same field) would read a
never-written field. Sound fusion REQUIRES §2a: a successor-CR-live-in scan
(peek target + fallthrough block starts, does each write CR[crfd] before reading
it) → a new branch-op field crFieldDeadAfter, gating the fusion. That is a real
analyzer addition with its own correctness surface (a mis-scan = silent guest
corruption). DECISION per the discipline (never confidence-over-accuracy;
native-exact; don't ship unprovable): NOT shipping the fusion; NO code edited
(tree stays at EA-CSE-landed). Scoped as task #15 blocked-on-analyzer. Note V8
does NOT store-to-load-forward the dead CR store across shared linear memory, so
the ~30 ops ARE executed — the win is real IF soundly fusable. Integer-quality
leg remaining ranked: cmp→branch fusion (needs §2a analyzer), CR-encode narrowing
by tested-bit (same soundness gate), bswap-elimination (host-byte-order RAM,
campaign-sized), Stage-B DSI self-exit (matched host raise).**

**PM55c 2026-08-04 — EA-REUSE CSE landed (green, correct, measurement-flat; kept).**
Per-block EaCache (LoadStoreParams.ea_cache, owned by emit_block_body_into):
emit_ea_d_form reuses LOCAL_TMP_EA when the immediately-preceding integer
D-form access computed the identical (ra, simm); the dispatch loop KEEPS the
cache only after a NON-UPDATE simple D-form op (even opcd 32-44) that did not
write the base — every other shape invalidates (FP/psq/X-form reuse TMP_EA
unkeyed; update forms restale the record by writing the base into it; ALU
base-writes change gpr[ra]; conservative on plain ALU = forfeit-not-break).
GATES 3457/0 + 77/0 incl. new ea_cse_stw_then_lwz_same_slot (store then load
same slot reads back 0xAABBCCDD — the reused address is provably identical).
MEASURED: SAB presentN ~327/snap (flat vs ~328 DSI — the same-slot idiom is a
small fraction of accesses), MP4 gc 6722 (best-band). Kept as clean correct
emit (PM50/PM53 precedent). INTEGER-QUALITY LEG CUMULATIVE: parity 296 → fixB
316 → DSI-delete 328 → EA 327 presentN/snap = +~11% (DSI-delete the real mover).
QUEUE (clean-by-inspection): compact-branch-decode (bne reads whole u64 CR to
test EQ; emit_crbit_test does i32.load+eqz — verify the coalesced path uses
it), then CR-ENCODE deferral on crDiscardable (the ~35-op cmplwi field build,
skip when consumed only by the next branch — needs the analyst discardable
gate). Then the architectural bswap-elimination (host-byte-order RAM, own
campaign) and Stage-B DSI self-exit (matched host raise).**

**PM55b 2026-08-04 — DSI-COMMIT GUARD DELETED (Stage A): dead code by oracle
proof, ~9 ops/load removed, both games improve.** Design workflow (wf_711c363b,
3 readers over the Dolphin oracle source) returned the PREMISE-FALSE verdict:
our shipping WASM build is MMU-off, Dolphin's GenerateDSIException early-returns
WITHOUT setting EXCEPTION_DSI when !IsMMUMode() (MAIN_MMU defaults false) + the
stateless fast-router never consults the MMU ⇒ no load/store fault EVER sets the
bit the per-load commit guard masked; eqz was always 1, the commit if always
taken. Deleted emit_no_dsi_guard + all 4 gated-commit sites (D-form load/store,
const-MMIO load/store) → unconditional commit; behaviorally identical (nothing
was ever suppressed), ~9 dead ops/load gone from the HOT path. GATES 3457/0 +
76/0 (the lwzu/stwu/trampoline DSI-adjacent tests are the guard — unconditional
== gated when DSI never fires). MEASURED (page metric): SAB presentN ~328/snap
vs ~316 (fix B) vs ~296 (parity) = +~11% CUMULATIVE across the integer-quality
leg, now out of the single-step noise band; MP4 gc 6859 best-yet (6617→6859).
LATENT BUG DOCUMENTED (currently unreachable): if DSI ever DID fire mid-block,
the block-end EXC_SYNC bail delivers with ctx.PC = terminator address = wrong
SRR0 (should be faulting op) — fixed for free by Stage B. STAGE B (native-exact:
slow-arm self-exit via check_exc + a matching HOST DSI-raise) stays DEFERRED as
a matched pair — shipping the emitter half alone spuriously exits every slow
load (check_exc returns 0, PC stays at op.address != op.address+4). Queue: the
clean-by-inspection EA-reuse CSE + compact-branch-decode, then CR-deferral.**

**PM55 2026-08-04 — INTEGER EMIT-QUALITY ATTRIBUTION (SAB scheduler block dumped +
wasm-dis'd) + fix B landed; the ranked per-instruction fat is NAMED with the
native-exactness verdict on each.** Dumped 0x800EBE00 (9 guest instrs, 17.9% of
SAB CPU vs native 1.28%): 785 wat lines, ~305 executed body ops = ~2.5-3x native/
instr. FAT (per-op counts, agent-attributed + hand-verified against jit_load_store/
cr_encode): (a) bswap 11 ops x4 mem-ops = wasm FLOOR (no MOVBE; only architectural
escape = store guest RAM in HOST byte order, own campaign); (b) fastmem region
guard 4 ops x4 = near-floor (wasm can't fault-handle); (c) DSI-commit guard 9 ops
x every load; (d) per-op set_pc 3 ops x mem-ops; (e) cmplwi CR-u64 encode ~35 ops
+ bne reads whole u64 to test EQ (~4); (f) EA recompute 5 wasted (stw 732(r6) then
lwz 732(r6) rebuild identical EA). LANDED fix B (3457/0 + 76/0): region bodies
skip the promote-counter prologue (~20 dead ops/block on the HOTTEST code — sealed
pcs never re-promote; standalone body still counts for eviction-recovery). SAB
presentN ~316/snap vs ~304 v3 (+~4%, noise-band, kept as clean dead-code strip).
CORRECTNESS CORRECTION to the agent's #1: moving the load commit into the fast arm
unconditionally is NOT native-exact — a prior slow op leaves DSI pending and the
speculative commit is observable by the guest exception handler (reads the reg
pre-vector). The EXACT form = the NATIVE model: slow arm EXITS the block on DSI
(PC=faulting-op, flush, return), so no later op runs with DSI pending → the
per-load commit guard (c) + the set_pc-for-DSI (d) become UNNECESSARY everywhere.
That is the real #1 — scoped as its own gated workflow (cold-path restructure of
every load/store). Clean-by-inspection wins queued behind: (f) EA-reuse CSE
(invalidate on RA-rebind), (e)-decode compact-branch (emit_crbit_test EQ vs whole-
u64 load). Then (e)-encode CR-deferral on crDiscardable.**

**PM54g 2026-08-04 — FUSION v3 LANDED (green, 3x coverage, bl/blr RAS working) —
present-rate +~3% (inside noise); the CPU-structure track has now been driven to
its measured floor on SAB.** Landed (3457/0 + 75/0; RAS-hit and forced-RAS-miss
tests exact-PASS): bl seams collapse to LR:=ret (registers live into the inlined
callee), blr emits the software-RAS check (LR&~3==continuation ? inline :
flush+PC=LR exit, Save/RestoreState-wrapped), driver chases one call deep
(callee FP-free + no LR writers: LK-branches/mtlr scanned per word), continuation
resumes at ret and keeps fusing. MEASURED (SAB): 46 runs/118 blocks gen 0 (46%
of the gen; bl=35, blr=10), presentN ~304/snap vs parity ~296 / v2 ~282 —
positive but ±noise. CAMPAIGN LEDGER after PM53-54: SAB has now had removed —
the dispatch tax (direct calls), the prologue tax on ~half the hot blocks
(fusion v3), the interrupt-storm theory (refuted by rate), all per-game patches
(dead weight) — and holds ~13-14fps user-metric. MP4 42-45 (wall = ps-body
quality). THE REMAINING RANKED LIST for SAB (all research-derived, none yet
tried): (a) integer emit QUALITY on the scheduler/AX code itself (the 2-3x
per-instruction cost vs native — the PM21 48%-of-thread item, never directly
attacked for integer code), (b) V8 tiering/warmup: module persistence +
cluster-pooled promotion (thousands of lukewarm blocks never reach TurboFan —
the tiered-JIT synthesis' un-landed items), (c) branch hints (M136+ on-by-
default, CheerpX 7-10%), (d) audio-core real-time coupling (audio-diag shows
core-below-real-time; whether the worklet backpressures the CPU pump is
UNVERIFIED). For >60 on MP4: the GPU-worker/OffscreenCanvas present path.**

**PM54f 2026-08-04 — FUSION v2 LANDED (green, FIRING) — page-metric WASH on SAB;
the coverage gap is CALL edges; v3 scope = bl-inline + blr check (software RAS).**
Landed (3457/0 + 73/0 incl. 3 new seam tests, all exact-PASS): AnalyzeOps
(pre-built op list + per-op pcs; fetch-shim proven impossible), m_noncontiguous
(gates self-loop/int-fusion/idle off fused bodies), seam backward-cond routed to
the coalesced mid-block exit, b-elision seams, the three-shape driver
(fwd/bwd/b-elide, single-pred, FP-free, cycle-guarded, seam-contract check),
dispatch_fused test entry. MEASURED: fusion FIRES on SAB — 14-22 runs / 20-49
blocks per gen, both shapes — but presentN-delta fps is a WASH (parity ~296/snap
vs v2 ~282): 12-19% of blocks fused ≠ the hot mass. The 0x800ebe00 disasm already
said why: the scheduler's hot path crosses bl/blr FUNCTION calls (runtime return
targets) — unfusable by branch-shape fusion. v3 = fuse THROUGH bl (target is
static): emit the callee inline and at its blr emit `LR==ret_pc ? continue
inline : exit` — the software-RAS inline (dynarmic-style); the g_blr_ras
machinery is prior art. NOTE the pattern across PM53-54: every structure change
lands green but washes because the TRULY hot transitions are one level deeper
(self-loop -> other blocks -> chain calls -> FUNCTION calls); v3 attacks the
actual measured shape. fps-drain quirk hit again (0 [fps] lines): presentN
deltas across phase-snaps are the robust page-metric — record as method.**

**PM54e 2026-08-04 — YIELD-INTERVAL FIX (user-visible) + RUN-FUSION v1 measured
INERT; the non-contiguous requirement is now MEASURED.** (1) HYBRID YIELD 4→16ms:
the 4ms timer-yield interval routed EVERY yield through the clamped setTimeout
whenever a pump turn took ≥4ms of work — the USER'S console showed turnAvg=4.8ms
return at steady state (busiest = most throttled). At 16ms, Dawn ticks still get
~60Hz service and heavy turns stay unclamped: turnAvg=0.0ms sustained through
3.8M steady-state batches, MP4 gc best-yet (6264/120s), fps unchanged on the
idle probe box (the fix targets LOADED machines like the user's). (2) RUN-FUSION
v1 (contiguous fallthrough-after-forward-conditional, seal-re-emit-only, zero
emitter changes) landed green — and fired ZERO times across 24 SAB gens: the
analyzer ALREADY coalesces forward conditionals inside blocks, so block
terminals are almost never forward-cond; the real in-batch edges are
UNCONDITIONAL b (non-contiguous target) and backward-bcx fallthrough. ⇒ the
fusion that pays requires the emitter's non-contiguous support: the 5
monotonicity sites from the branch-following audit (coalesced fall-through
jit_branch.cpp:236-class, terminator PC fixup, fallback exception-detect
PC==addr+4, self-loop detect, contiguous fetch window) must take per-op PCs.
That is the scoped next leg (task #10 v2); v1's selection/census scaffolding
(ft_preds, rec_is_fp_free, depth/size caps, the run-fusion log line) carries
over. USER-METRIC snapshot (their loaded machine, their console): MP4 movie
12.9fps + green-bar tear (the PM45e pace-coupled residual — closes with speed),
menu/title 21.8 — roughly 0.5x the idle probe box; their numbers are the bar.**

**PM54d 2026-08-04 — DIRECT-CALL PAYLOAD LANDED (green, ships) + the V8-inlining
ceiling MEASURED; next design named: BOUNDED RUN FUSION.** Landed (conf 3457/0 +
70/0, freshness PASS): seal-re-emit static-edge direct calls — the region lookup
(previously (void)-discarded in the N-fn path) now threads into
emit_block_body_into/emit_chain_or_return; terminal bx/bcx-taken/fallthrough
targets that resolve in-batch emit `PC==T ? return_call(WIMPORT_COUNT+idx)` arms
after the unchanged service checks, and the PM47 self-edge goes direct when
in-batch. MEASURED (page metric, default tiering): MP4 41.7-44.6 / gc healthy,
SAB 12.5-14.4 — PARITY on both, not the hoped jump. ROOT CAUSE MEASURED via
--trace-wasm-inlining + PROBE_DUMPIO=1 (the trace goes to Chrome stdout, NOT the
page console — dumpio required): V8 DOES inline our direct calls (monomorphic,
"inlining direct call" events) but the PER-CALLER BUDGET caps it: 42,784 call
sites considered, 501 inlined (~1.2%), 2,273 explicit budget refusals — and our
~90-op per-block prologues inflate every callee's size/score against that budget
(circular: the prologue exists because each function re-derives register state).
⇒ V8 inlining cannot carry the structure removal. NEXT DESIGN (the flycast-wasm
recipe verbatim, their 2fps→locked-60 second ingredient): BOUNDED RUN FUSION —
at seal re-emit, fuse statically-connected hot RUNS (2-8 blocks: A's static
branch to in-batch B with B single-predecessor-in-batch) into ONE function where
the branch becomes a wasm branch and the REGISTER CACHES STAY LIVE across the
seam (one prologue per run — the actual deletion of the 90-op tax, engine-
independent). The integer self-loop fusion's convergence machinery (PM53h:
head-flush state parity, test-then-charge) is the seed; the run case needs
linear-chain state carry, not loop convergence — strictly simpler. Probe-hygiene
rule recorded: V8 trace flags need PROBE_DUMPIO=1.**

**PM54c 2026-08-04 — N-FN REGION BRING-UP COMPLETE: live on ALL THREE GAMES at
parity, zero traps, promote=1 SHIPS.** The audited fix set (wf_33f3e571) landed in
full: (1a) gen-packed rslot ((gen<<16)|i) in BOTH shapes, populate relocated to the
seal-SUCCESS branch; (1b) region_gen_idx plumbed emit_block_body_next →
emit_block_body_into → emit_chain_or_return; (1c) own-gen check + 0xFFFF mask in
the N-fn chain arm (cross-gen slot confusion impossible BY CONSTRUCTION —
other-gen hits fall through to the host, the global buckets re-enter the owning
gen); (1d) same check+mask in the PM47 self-chain probe under region bodies; (2a)
pending cap == seal_batch() (shared helper; the old per-window cap let pending
stack to 284); (2b) EM_ASM_INT seal-success flag + commit/populate ONLY on
success, fail-streak brake at 3; (2c) region_reset_pending helper — every early
seal exit releases the batch (overflow PATH B closed) + empty-insts guard in
promote_hot; (3a) seal-time compaction+refresh vs live m_pending_emit (stale
pre-SMC content class closed at one site). MEASURED (page metric, default
tiering): MP4 10 gens (all n_funcs<=256), 42.9-44.6fps / gc 5156 = parity with the
44.6/5128 no-patch baseline, PM53e wedge GONE; SAB 24 gens (at MAX_GENS cap),
11.5-14.0 = parity; PSO 13 gens, 19.2-19.5 = parity. Zero FAILED seals, zero
traps, conf clean at compile. PARITY IS EXPECTED: the perf payload — the
seal-re-emit rewriting intra-gen chain exits as DIRECT return_call via
rs.pc_to_idx (same-instance + ≤500-wire-byte functions ⇒ V8 speculative inlining
+ TurboFan prologue deletion across seams, per the PM54 research) — is NOT yet
implemented; that is the next leg, followed by the tiering synthesis items
(wf_b884544b: branch hints M136+, cluster-pooled work-unit promotion, RAS port
into gens, observed-arms-only singles, module persistence for warmup).**

**PM54b 2026-08-04 — ALL PER-GAME HLE PATCHES STRIPPED (user directive: mirror
native, which installs NONE) — verified dead weight.** The reference fact, cited:
pristine dolphin HLE.cpp PatchFunctions (:109-137) applies non-Fixed patches ONLY
for names found in the symbol DB; the oracle invocations load no symbol map ⇒
native dual-core runs retail titles on PURE PowerPC execution, zero patches. Our
EmscriptenWorker.cpp per-game set (7x PPCMfhid2/strncpy/OSReport/___blank +
TraceDispatcher + MP4 GXWaitDrawDone FAKE_TO_SKIP_0) is now behind
kInstallLegacyPatches=false (default OFF, '[worker] HLE patches: NONE (native
parity)' printed). A/B BOTH GAMES: MP4 boots+renders, 44.6fps/gc 5128 (at/above
the prior 37-45 band); SAB boots+renders 11.8-14.2 (same band as patched). The
GXWaitDrawDone skip's own comment claimed boot hangs without it — boot works: the
seam was fixed by the PM12-era restructure and the patch was stale compensating
bloat. ALSO REVERTED unbuilt: the PM54 THP-HLE direction (per-title decoder
patch) — rejected by directive before landing; the 60fps path is GENERIC (JIT
quality + topology), any game, no per-title knowledge. The abandoned wiring is
fully backed out (HLE.cpp/HLE_Misc/EmscriptenWorker/link script).**

**PM54 2026-08-04 — WEB RESEARCH SYNTHESIS (wf_007b7f74: porffor/v86/flycast-wasm/
V8 internals/HN) + zero-yield pump landed. THE MISSING THING = MODULE TOPOLOGY:
V8 (M137+) speculatively inlines call_indirect/return_call_indirect SAME-INSTANCE
ONLY — our per-block modules are CATEGORICALLY ineligible (the mechanism behind the
12.9%/4.8M-calls-s tax). The shipped 60fps proof: the flycast-wasm sibling went
2fps -> locked 60 via (a) batched MULTI-FUNCTION modules (compile 1ms -> 20µs/block)
and (b) fused hot chains ("block A's static branch to B becomes a WASM branch") —
their description of the pain matches ours verbatim (3-6-instr hot loops, register
cache dies at every boundary). v86 documents our merged-region failure shape (deep
br_table + whole-function locals) as the KNOWN pathology; the correct shape = many
SMALL FUNCTIONS in ONE module, few entry points — functions ≤500 wire bytes get
TurboFan-INLINED into predecessors same-instance, deleting the prologues across
seams (directly attacks SAB's 15-20x tiny-block amplification). NO OSR for wasm =
merged loops pin to Liftoff (second mechanism for the merged-shape losses); tier-up
needs ~5k-15k executions/function so thousands of lukewarm blocks never tier (the
user's tiered-JIT intuition + SAB's pain). Also: emscripten_thread_sleep may be a
BUSY sleep (issue #20000; PM16 measured ~13% in sleeps — verify our 4.0.10);
DevTools attached = TurboFan discarded (probe hygiene). Landed this entry:
MessageChannel HYBRID zero-yield pump (worker_funcs.js; pure MessageChannel loop
STARVES the timer source — Dawn ticks/readbacks are timer-scheduled, presents froze
after frame 1; hybrid = unclamped yield + real setTimeout every ~4ms). turnAvg
4.8 -> 0.0ms, MP4 unchanged 37-44fps (pump was not the limiter — PM15's 2.4% util
confirmed; video IS the easy part). ⇒ THE PLAN: N-fn gens as ONE MODULE of SMALL
FUNCTIONS with intra-gen DIRECT return_call edges (task #2 bring-up), then emit
quality (Porffor lesson: body quality > layout), then the GPU-worker/OffscreenCanvas
present for >60 (needs an emdawnwebgpu surface-on-pthread smoke test). Full
synthesis: wf_007b7f74 output file.**

**PM53i 2026-08-03 — SAB DSP-CADENCE HYPOTHESIS REFUTED (one instrumented probe,
diags stripped, clean rebuild): our DSP-int raise rate = 147-370/s wall (~comparable
or BELOW native's ~580/s once speed-normalized) — NO interrupt storm. The SAB
scheduler's 8x share is therefore per-pass COST at its extreme: the scheduler's
3-6-instr blocks pay the ~90-op per-block structure ≈ 15-20x op amplification on
ultra-tiny blocks (the PM53f class, worst case). ⇒ EVERYTHING CONVERGES on the
structural fix: N-fn region bring-up (small per-block functions per gen module +
intra-gen direct return_call edges + later the per-edge prologue-skip contract) is
THE path for BOTH games — task #2's bring-up (fix the >cap bookkeeping wedge) is the
next leg. Board (user metric, default tiering): MP4 title 37-45fps (fused build;
gap ~1.4-1.6x), SAB 13-16 in-probe / 10-12 user (gap ~4x, structural), movie ~17.
Tree state: fusion ENABLED, conf 3457/0 + 70/0, all TEMP diags stripped.**

**PM53h 2026-08-03 — INTEGER SELF-LOOP FUSION LANDED (green, kept) + the tiering
discovery that re-ranks everything.** Fusion implementation (design wf_b760b301, all
gates green 3457/0 + 70/0 incl. the new fused_intloop_runs_to_exit — 10 iterations in
ONE activation, census-proven): prescan_int_self_loop whitelist (D-form arith/logic/
loads/stores + OE=0-gated 31-subops + native CR-bit/bdnz terminals; conservative — a
false negative only loses fusion), emit_bcx_fused (shared emit_crbit_test factored so
the GT/SO polarity lives ONCE; head-flush convergence makes the back-edge state free;
TEST-THEN-CHARGE downcount on the back-edge — charge-then-test would overcharge every
bail; 3-term guard incl. dispatch-tag liveness), wasm loop/br wrap in
emit_block_body_into. MEASURED on the corrected metric (page-fps): SAB wash (12.7-15.6
vs 13-16.6 — its hot scheduler blocks are branchy-NON-loop), MP4 no-liftoff wash
(24-32, gc 3941), MP4 default-tiering fused 43-44.9 vs CONTROL (fusion-off, one-
variable A/B) 37-43.6, gc 4384 vs 4311 — fusion = small-to-noise; KEPT (PM50
precedent: correct, removes real work, protects the Liftoff phase). THE RE-RANKING
DISCOVERY from the control: DEFAULT TIERING BEATS --no-liftoff BY ~45% ON MP4 (37-44
vs 24-32 fps — opposite of PM39's era) ⇒ (a) all --no-liftoff numbers UNDERSTATED the
user metric; MP4 title in the user's environment ≈ 37-45fps — the 60fps gap for MP4 is
~1.4-1.6x, NOT 4x; (b) SAB at 10-16 is THE OUTLIER and its lever is the PM53g
scheduler/cadence pathology (~8x native share), not emit quality. NEXT: SAB cadence
leg — instrument wake/DSP-int rate (native axei-trace ≈ 580 DSP-int/s reference),
find the excess-wake source, fix at the device seam. Then: warmup/get_now, PSO A/B.**

**PM53g 2026-08-03 — METRIC CORRECTED (user directive) + SAB PROFILED vs NATIVE:
scheduler share ~8x inflated.** (1) THE metric = gamecube.html's own bottom-bar FPS
in the user's REAL Chrome (default tiering), per game — user's SAB read 10.1fps while
I quoted probe gc-rate (--no-liftoff) as "59% native"; memory
feedback_metric_is_page_fps_real_chrome_2026_08_03 is binding; probe A/Bs for the
product now use PROBE_JS_FLAGS=" " (default tiering). Corrected board: SAB 10-12fps
(user) / 13-16.6 (idle-machine probe), MP4 movie ~17, bar = 60 ⇒ ~4-6x. (2) SAB
default-tiering PC profile (22.6K samples, gsne8p.map + disasm_fn.py): top bucket
0x800ebe00 = 17.9% = the UNMAPPED dolsdk scheduler gap between OSEnableScheduler and
OSCancelThread (queue link/unlink + RunQueueBits |= at -30176(r13) = SetRun/
OSWakeupThread/__OSReschedule class), plus 0x8011d-80120 cluster ~18% (MusyX/AX),
HandleReverb 3.5%. NATIVE SAB oracle (build-oracle dual-core, 118K samples): the same
scheduler gap = 1.28% total (~2.1% of busy); native top = 0x80117e00 39.4% (its idle
loop — ours correctly idle-skips it). ⇒ our scheduler share is ~8x native's busy-share:
per-block structure tax on tiny branchy OS blocks (~3x, the PM53f class) x likely
excess wake rate (the PM5 DSP-storm class, steady-state variant) — the split needs an
execution-count instrument (g_bem_pc_exec is promote-gated; needs a standalone gate).
DISCRIMINATOR IN FLIGHT: the integer self-loop fusion A/B on page-fps — a
disproportionate SAB jump = structure; flat = cadence leg next. Native SAB DSP-int
rate from axei-trace ≈ 580/s for later comparison.**

**PM53f 2026-08-03 — HuffY NORM DECODED: the 2.7-3.2x is the PER-BLOCK STRUCTURE on
tiny integer loops; the lever = INTEGER SELF-LOOP FUSION.** ELF disasm of the live-
histogram hot core (0x800E0900-0BFF = 79% of __THPHuffDecodeDCTCompY): branchy
Huffman bit-reader blocks of 3-10 instrs; hottest = the 8-instr backward-bgt scan
loop 0x800e09b0-09cc. Integer self-loops have NO fast path (fast_loop requires an
FPR assumed set), so each 8-instr iteration pays ~90 emitted ops (GPR prologue ~18 +
bcx flush ~20 + chain probe ~24 + downcount + tail-call) ≈ 3x at IPC4 = the measured
norm EXACTLY. FUSION for is_self_loop && assumed==0 && !merged && FP/interp/HLE-free
blocks: wrap the body in wasm loop/br, back-edge = downcount>0 && Exceptions==0
(~38 ops/iter, ~-58% on the loop). PM40's do-not-retry covered the ps/IDCT shape
(body-dominated + FPR residency); this integer shape is outside it. Also hits
__mod2i (15x), GetBezier (9-15x), tiny OS loops. Design + A/B rig in task #3.**

**PM53e 2026-08-03 — N-fn shape A/B WEDGED; region work parked pending an N-fn
bring-up leg; shipping baseline restored and verified.** Flipping s_merged_enabled
=false (N-fn: per-block functions in one module/gen, intra-gen edges via the
module-INTERNAL declared table) + promote ON sealed 4 Nfn gens but WEDGED the guest
(gc froze at ~184 ticks in-window, dataAddSampleReference spinning ~2900x, and gen 2
reported n_funcs=284 > the 256 batch cap = bookkeeping corruption on that path) —
the N-fn dispatch/registration wiring is not bring-up-complete under the current
topology (an old comment already flagged the rtag path "NOT dispatched yet").
promote gate OFF (do not re-flip in ANY shape without a dedicated bring-up leg);
final verify: 37.9 gc/s, IDCT 7.7x, 0 seals, fps ~31 — the day's shipping band.
NEXT LEG (region track): N-fn bring-up — fix the >cap bookkeeping, trace one wedge
(dataAddSampleReference spin = a musyx-adjacent block mis-dispatching), then the
direct return_call edge rewrite via region_lookup_for_emit. PARALLEL non-region
levers stay live: HuffY/Reverb norm profile, get_now batching, warmup, PSO scene A/B.**

**PM53d 2026-08-03 — SINGLES-IN-REGIONS LANDED AND MEASURED; the merged shape is
CLOSED by three consistent negatives; the successor shape is NAMED.** Step-1 work
(all KEPT, conformance 3457/0 + 69/0): (1) the `!merged` singles exclusion at
ppc_emit.cpp:843 lifted — merged bodies emit the PM44/46/47 dual arms (fast_loop
stays per-block: its spill/flag exit has no merged publisher); (2) EMISSION BUG
FOUND VIA WebAssembly.validate: the dual-arm tail's dead `i32.const 0` function-
result filler is valid per-block but a stack-height violation spliced into the
region's void context — every ps-heavy gen was INVALID (validate=false), and the
failure was INVISIBLE because (3) worker console.error does NOT relay to the probe
log (all seal catches converted to console.log with FAILED markers). With the fix:
all gens validate/compile/instantiate (580 blocks incl. a 2.4MB 248-fn ps gen),
zero traps, renders. VERDICT under --no-liftoff (TurboFan-only, tiering
exonerated): 34.4 gc/s vs 39.7 per-block baseline; IDCT 8.3x vs 7.3, MixAudio
9.5x. Combined with step-0 (-38%, Double-only) and 07-16 (-8%, pre-singles), the
giant-function br_table merged shape LOSES on V8 at this scale even with singles —
the historic phi-merge microbench refutation did not cover 152 locals x 580 arms.
Gate back OFF; baseline verified (37.8 gc/s, 0 seals; day band 37.2-40.0).
SUCCESSOR SHAPE (next leg, do not re-flip merged): N-fn gens + intra-gen DIRECT
return_call edges — the seal re-emit knows every batch pc's module-local function
index (rs.pc_to_idx), so chain exits targeting the batch become direct calls (no
table/signature tax, no giant function; V8 optimizes small functions); the
per-edge exit-mask ⊇ entry-mask verify-hoist then rides the same re-emit. Probe
default is --no-liftoff (dolphin_render_probe.js:135) — user-browser default
tiering makes giant functions WORSE, another point for N-fn. Ranked after:
HuffY/Reverb norm, get_now, warmup, PSO scene A/B.**

**PM53c 2026-08-03 — REGION PIPELINE UN-BROKEN (two real bugs fixed) + step-0 regions
A/B measured; the Step-1 pairing is named.** Scoping (5-agent wf_4be6b547): the graph-
merge path is the REGION machinery, not analyst branch-following (flags declared-but-
dead, 5 emitter monotonicity assumptions, upstream follows only unconditional branches —
useless for the THP graph whose boundaries are conditional/backward). Step-0 (flip
g_bem_promote_enabled) initially did NOTHING silently — two pipeline bugs found by one
temp-diag probe (both fixed, KEPT): (1) SEAL CADENCE DEADLOCK — the partial-seal
required promoted==0 per window but per-window histogram jitter trickles >=1 marginal
block every window (measured pending 244→245→246 forever); fix = tolerate promoted<=4.
(2) ASYNC SEAL NEVER REGISTERED under dual-core — WebAssembly.instantiate(...).then()
microtasks NEVER drain on the non-yielding EmuThread pthread (continuous run loop +
Atomics.wait throttle), so gens sealed C++-side but never went live; EVERY post-07-22
region A/B silently measured per-block dispatch; fix = synchronous
new WebAssembly.Instance(new WebAssembly.Module(copy)) (workers have no sync-compile
size limit; one Liftoff compile per gen). WITH the pipeline live: 7 gens (568 blocks)
sealed+registered+ran, zero traps, renders — and MEASURED 24.6 gc/s vs 39.7 baseline,
IDCT 7.3x -> 15.4x: merged bodies are DOUBLE-ONLY (singles-spec excluded via `!merged`
at ppc_emit.cpp:843), so THP ps blocks lose the PM44/46/47 singles arms inside regions —
the structure win cannot offset that loss. Gate flipped back OFF; baseline re-verified
EXACT (39.7 gc/s, IDCT 7.3x, 0 seals). => STEP 1 (the measured path to the ~40% prize):
lift the !merged singles exclusion + make the dual-arm entry guard address branch
targets through MergedRegionCtx::br_extra_depth (the emit_chain_or_return pattern at
its :258-273), THEN flip the gate ON as a pair. Step 2: hoist the verify via per-edge
exit-mask ⊇ entry-mask at seal time; warm edges that fail the mask rule fall through to
the standard re-verify probe (never wrong values, only slower). Full decision map:
wf_4be6b547 output. Ranked after: HuffY/Reverb norm, get_now, warmup.**

**PM53b 2026-08-03 — bench built; function decomposed; chain-edge interim REFUTED and
REVERTED; the lever is now unambiguous.** (1) NEW RIG: test_gekko_next
`idct_selfchain_bench` (runs FIRST in the suite; a 240s-timeout run.mjs run persists the
log early) executes the exact IDCT self-loop through the real self-chain: 152-155
ns/iteration steady (NI=1), 117-135 NI=0 (the runtime-gated flush arms = ~24%), per-HOST-
entry cost ≈1.3µs (CTR=64 variant). CAVEAT measured on a warm machine: bench run-to-run
spread reached ±9% (identical code 152→179) — bench deltas under ~15% are not attributable;
the live probe with per-function cost_x remains the arbiter. (2) DECOMPOSITION (256B-bucket
split of the live PC histograms over the full fn span 0x800DEB20+0x1AAC): the famous
53-instr self-loop = only 9.4% of __THPDecompressiMCURowNxN's time (native 6.8%); ~90% is
the OTHER ~25 blocks — every inter-block chain entry re-pays EmitAssumedSingleLoads
verify/PEM + GPR prologue + the V8 per-call tax. This explains ALL the PM53 washes
(op-shaving a 9% slice of a 44% function ⇒ ~1-2% expected = measured). (3) CHAIN-EDGE
EXPERIMENT (generalize PM47 flag/scratch to chain edges; v1 clear-mode, v2 FPR-clean
forward-mode): conformance-green both, but LIVE = 36.5 / 35.8 gc/s vs 40.0/39.7
bracketing baselines, all cost_x inflated — per-transition overhead (3S+3 epilogue spill,
12-op two-cell entry check, forward branches) outweighs the hits. REVERTED, verified
restored (39.7 gc/s, IDCT 7.3x); do-not-retry note at the ppc_emit.cpp cell decl. KEPT
from the leg: the bench, the C-loop PM47-flag clear (block_cache.cpp, hygiene), the
[fpscr] probe one-shot (NI=1 CONFIRMED live — the emitter comment claiming movie-NI=0 was
wrong). (4) THE PATH TO 60FPS, now measured three ways: merge the block graph so
prologues are paid once per REGION not per block — full branch-following/regions
(ppc_analyst m_enable_branch_following + emitter non-contiguous-PC + taken-branch
inlining + reg-state convergence at joins). Secondary: HuffY/Reverb norm (2.7-3.3x),
get_now (2.5%), warmup. Current verified state: MP4 39.7-40.0 gc/s = 59% native, title
29-33fps, movie ~17fps visible, SAB 14.5, PSO 19-20 (scene-window question open, task
#6), conf 3457/0 + 69/0.**

**PM53 2026-08-03 — fresh twin-sampler oracle + IDCT executed-arm attribution + TWO
conformance-green landings, both measured ~WASH => op-count model is DEAD for the IDCT
loop; fixed per-iteration cost named as the binding constraint; PM40's fusion-wash
rationale INVALIDATED.** Fresh oracle (native build-oracle 60s sampler + 120s probe
PC-sampler, gc window 33..3939): 39.0 gc/s = 58.1% native (67.2), native 63.3% idle vs
our 11.2; IDCT 49.4% @ 7.5x, HuffY 2.6x/9.0%, Reverb 3.3x/8.2%. 2-agent wasm-dis
attribution of the live IDCT module (80,857 B dump, adversarially verified): 3489
executed ops/54-guest-instr iteration = entry 25 + FPR reentry 35 + GPR prologue 18 +
psq_l 432 + arith 1319 (1024 = NI denorm-flush arms, NI=1 CONFIRMED live via new probe
[fpscr] one-shot) + psq_st 720 + int 32 + terminal 761 (684 = promote-flush of the 9
NON-live-in dirty Singles) + dead pc stores 147. LANDED (conf 3457/0 + 68/0 both): (1)
PW-SKIP — terminal bcx skip mask extended to dirty∧Single∧¬assumed∧¬m_fpr_inputs
(frc.DirtySingles() accessor; taken arm loses all 18 extract_lane promotes, verified in
wat; plain path still full-flushes). (2) NI-VEC — emit_v128_ni_flush two-lane scalar
extract/select ladder (32 ops, SIMD→scalar→SIMD on the result chain) → whole-vector
bitselect form (11 ops; new builder ops v128.const/i32x4.lt_u/v128.bitselect, opcode
bytes verified vs wat2wasm). ALSO FIXED: emit_coalesced_taken_exit never cleared the
PM47 flag (stale-scratch fast-reentry vector for ps self-loops with mid-block
conditionals — found by the 5-agent GPR-residency map, which also REFUTED the queued
"GPR residency on the PM47 flag" item outright: GPR entry is already 3-op lazy loads,
zero delta, plus a trap-path hard blocker). MEASURED: 39.0→39.4→40.0 gc/s, IDCT
7.5→7.4→7.2 across the two landings = inside the drift band, NOT attributable. THE
FINDING: −39% executed ops moved wall-time ≤2.6% ⇒ the loop is bound by per-iteration
FIXED cost (return_call_indirect back-edge + fresh-activation setup + V8 per-call
dispatch, the same tax PM52's census measured at 4.8M calls/s = 12.9%), NOT by body op
count. This contradicts PM40's "TurboFan already loop-optimizes the self-tail-call"
wash rationale — with today's 5x-leaner body the in-function loop back-edge
(self-loop fusion, PM40) must be RE-TESTED; the 5-agent map's §4 sketch (intra-function
loop/br, back-edge check downcount>0 && Exceptions==0 && tag-valid, locals survive
iterations, CTR hoisted to a local) is the design. NEXT RANKED: (a) self-loop fusion
re-test (decisive first instrument: flip the PM51 census counters for ONE probe →
chainTaken/s during the movie → actual ns/iteration vs op count), (b) branch-following
(PM52 #1, the non-self-loop 12.9%), (c) HuffY/norm integer profile. PARITY: MP4 movie
window unchanged-to-slightly-better, SAB 14.2-14.9 (parity), PSO renders clean but
19.2-20.5 @t=134-137s vs PM47's noted ~29.8 (window unstated) — UNATTRIBUTED, needs a
scene-aligned A/B before reading it as a regression. Probe gained a permanent [fpscr]
NI one-shot (dolphin_render_probe.js).**

**PM52 2026-08-03 — chain census CLOSED; cap experiment REFUTED; the structural lever is
NAMED.** Census (one instrumented probe, counters now compile-gated off): serviceBail
1.16M / vectorBail 0 / chainTaken 362.5M / tagMiss 69K per 75s = **99.66% in-wasm chain
hit-rate, 4.8M cross-module return_call_indirect per second** — the 12.9% EmuThread
dispatch cost IS V8's per-call table+signature dispatch on those 4.8M calls, not loop
iterations (the C loop runs only ~16K/s). Block-cap 64->160 A/B: chainTaken UNCHANGED
(hot blocks are TERMINATOR-bounded, branches every <64 instrs) — REVERTED (also
protects the cold-compile transient). => The ~13% is recoverable ONLY by merging
BRANCHY block graphs into single compiled units: branch-following
(ppc_analyst m_enable_branch_following, defaults false — PM39's #1) and/or the region
redesign (prior art: promote/region machinery OFF for the ~5% coverage wall,
[region-ab 2026-07-13]). THE RANKED CAMPAIGN NOW: (1) branch-following (emitter must
handle non-contiguous PCs + taken-branch inlining), (2) get_now bridge batching (2.5%),
(3) warmup (user transient), (4) guest-block quality continues (55.8% of the thread;
IDCT 8.1x, norm 2.7-2.9x). Current clean state: MP4 movie ~16fps visible / title 27-31,
93.3% renders, conf 3457/0 + 68/0, census counters gated (BEM_PM51_CENSUS=false,
BEM_DISPATCH_CENSUS=0).**

**PM51 2026-08-03 — CPU-PROFILE RE-ANCHOR (op-count model retired).** PM50 (set_pc
narrowed to Jit64 parity: FL_USE_FPU stores pc only at the block's first FP op; psq_l
FLOAT GQR-const arm) = conformance-green but a MEASURED WASH (gc 2179 vs 2213 — within
drift): ~250 emitted ops/iter of stores/branches are pipelined-free. KEPT (correct,
less code). RULE CONFIRMED AGAIN: neither wat lines NOR executed-op counts predict
cycles — only the profiler does. EmuThread profile (worker_2, movie): 55.8% emitted
guest blocks, **12.9% bem_chain_loop_c (the C dispatch loop — largest non-guest cost,
unchanged since PM16's 11.5%)**, 11.8% futex/timed waits (throttle, correct), 2.5%
_emscripten_get_now (clock-bridge), 1.6% mid-run compiles, ~2.9% wasm-to-js/EM_ASM/
growMemViews. 12.9% dispatch self-time => MILLIONS of C iterations/s => most block
transitions MISS the in-wasm tail-chain (bail classes: downcount, deliverable-exc,
vector-page, tag-miss, slot<0). NEXT (measure before fixing): flip the compile-gated
chain-iters/pc-census counters (block_cache.cpp ~458 'flip to 1 to re-arm') for ONE
probe -> which bail class dominates -> fix that class (candidates: deliverable-exc
window too wide, tag collisions in the 18-bit direct map, unsealed per-block modules).
Also queued: _emscripten_get_now batching (2.5%), the residual EM_ASM source (~1.4%).**

**PM49 2026-08-03 — console-signal audit (user directive: "signals in the regular
comments").** Findings: (1) REAL stale flag: the takeover gate's `rendered` input read
window._firstFrame, set ONLY by the legacy postMessage 'render' handler — dead since the
sab-present migration (PM28). FIXED: sab-present paint now sets it (+ prints
"[render] first frame (sab-present)"). (2) But READY=false is BY DESIGN: the ppc-worker
takeover was RETIRED 2026-07-21 ("NO takeover under real dual-core" — gamecube.html
~2184); the park-trap flag (0x026B0980==2) is intentionally never armed. The recurring
[gate-diag] READY=false print was a standing FALSE failure signal — SILENCED (if(false)
gated, code kept). (3) [crash-slot-direct] silenced likewise: 0x801e6d34 is XFB video
memory (established PM45b), not a crash slot. Console now carries only true signals:
[build] stamp (PM48c), [render] first frame, [fps] per second, [audio-diag] real-time
ratio, [tick-diag] pump cadence, plus real errors (err_hunt: ZERO). 60fps path unchanged:
the ranked JIT levers (PM48c list) — the console was never hiding a shortcut.**

**PM48c 2026-08-03 — console "1 error" FIXED + fps-framing CORRECTED.** (1) The permanent
"1 error" in every user capture = gamecube.html:7 `<link rel="icon" href=",">` — a literal
comma favicon URL 404ing every load (found via gamecube/tools/err_hunt.mjs, a NEW reusable
diagnostic: loads the page and prints every console.error/pageerror/requestfailed/4xx).
Fixed: href="data:,". err_hunt now reports ZERO error signals. (2) FRAMING CORRECTION
(gate #6): my late-window fps reports (31-37) measure the TITLE SCREEN — the probe's [fps]
lines only surface in the drain window, by which time the movie has ended. The MOVIE scene
the user watches runs ~16fps user-visible = EXACTLY the measured 54%-of-native (30fps
content x 0.54). The gc-rate scoreboard was always scene-normalized and correct; per-scene
fps must be quoted per-scene. Movie at full speed (30fps) requires the same ~1.85x the gc
arithmetic demands; 60fps-class output = post-movie gameplay at pace. Ranked levers
unchanged (PM48b list): psq_l float arm, GPR residency, WARMUP, HuffY norm profile.**

**PM48b 2026-08-03 — psq_st GQR-CONST EXECUTED ARM LANDED: gc 2093 -> 2213/75s (+5.7%),
fps 31-37, renders, conf 3457/0 + 68/0.** emit_psq_st reads the LIVE GQR at emit time
(g_bem_lc_base-gated); quantized int types (U8/U16/S8/S16) get a guarded arm with the
scale factor as ONE f32 constant (bit-exact mirror of emit_psq_factor_from_scale:
(127+sext6(scale))<<23) and the sign/width clamp tree resolved at compile time; full
32-bit GQR-equality guard falls back to the byte-identical generic body. Dump 74,121 ->
78,937 B (8 specialized arms added). The MP4 pixel stores (GQR6=0x3d043d04 U8) are the
target. TEAR STATUS: still intermittent (capture shows one) — pace-coupled; native on
equally-slow hardware has the same race, native escapes by GPU pace; full fix = 60fps or
the parallel GPU worker. REMAINING RANKED: psq_l FLOAT GQR-const arm (small), GPR
residency on the PM47 flag, block-cache WARMUP (the user-visible early-window ~15fps =
tier-up + cold-block compile storm; cache-warmup-opt* branches = prior art), HuffY
integer-norm profile (norm 2.7-2.9x is now half the remaining gap).**

**PM48 2026-08-03 — post-PM47 oracle re-rank (twin samplers, gc window 569-1346):
in-window speed = 41.3 gc/s vs native 76 = 54%% native (movie steady ~32-38fps late-window;
the user's ~15fps reads are the FIRST-MINUTE transient: V8 tier-up + cold-block compile
storm — block-cache warmup is the UX item; prior art = cache-warmup-opt1/2b/3 branches).
Cost vs native: IDCT 8.1x (was 9.1 post-PM46, 20x day-start), HuffY 2.7x, HandleReverb
2.9x — the norm itself is now ~2.7-2.9x. Arithmetic: IDCT->norm alone ≈ 66 gc/s = 87%%
native ≈ 52fps; 60 needs that PLUS shaving the ~2.8x norm (integer/dispatch quality).
RANKED NEXT: (a) psq_st U8 + psq_l FLOAT GQR-const EXECUTED arms (the remaining IDCT
excess), (b) GPR residency on the PM47 flag (skip GPR prologue/flush on self-chain),
(c) block-cache warmup for the first-minute transient, (d) norm-shaving: HuffY is pure
integer — profile its emitted blocks next (same wasm-dis attribution method).**

**PM47 2026-07-31 — SELF-LOOP RESIDENCY LANDED: MP4 ~29-30 -> ~32-38fps; day cumulative
21 -> ~35 (+60-80%).** Native keeps registers resident across its 53-instr IDCT loop; we
paid ~4K wat lines of ACTIVATION overhead per iteration (entry: guard + volatile
value-verify + PEM-inverse v128 rebuilds ~160 ops/reg; exit: promote-flush ~90 ops/reg).
Design (deopt-free, sound): the singles arm's SELF-CHAIN exit spills assumed v128s to
scratch (0x026B3C00+preg*16, 3 ops/reg) + publishes flag 0x026B38C0=start_pc IMMEDIATELY
before the direct tail-call to itself; re-entry sees flag==me -> mask-check only + one
v128.load/reg (verify + rebuilds skipped). Soundness: the flag is only live across the
direct self-tail-call — every other exit writes 0, host dispatch/trap/ReloadAll clear it.
IMPLEMENTATION LANDMINES HIT+FIXED: (1) missing instruction in the idct_wasm_dump array
(53 vs 54 words) made self-loop detect refuse — byte-identical dumps were the tell;
(2) terminal bcx's unconditional frc.Flush promoted the assumed set (fpr_flush_skip param
added, terminal-bdnz call site passes assumed); (3) dirty-at-entry state interacted with
the MSR.FP bailout's COMMON-PATH flush (demoted everything at op#0) -> redesign: entries
CLEAN + FPRRegCache force-flush set (host-visible Flushes still write them) + bailout
flushes moved INSIDE the bail arm with Save/RestoreState (fall-through keeps pre-bail
state — also un-pessimizes every ps block generally). Emission verified via wasm-dis
census (3rd return_call_indirect + flag x4 + 20 spills). VERIFIED: test_diff_next 3457/0,
test_gekko_next 68/0, MP4 32-38fps renders clean (NO tear stripe in the capture — faster
decode shrinks the tear window), SAB ~14 renders, PSO ~29.8 renders. NEXT: psq_st U8
GQR-const executed-arm spec, GPR residency on the same flag (rc prologue skip), then
re-oracle the gap table.**

**PM46 2026-07-31 — FPRF GATE (native-exact) LANDED: MP4 ~24-27 -> ~29-30fps (gc 24.3 ->
27.6/s); cumulative today 21 -> ~30 (+43%).** Method correction that found it: wat LINES
!= EXECUTED ops for branchy emitters (the 725-line psq_st is mostly dead type arms; one
executes) — re-ranking by STRAIGHT-LINE bodies exposed the real cost: every SIMD arith op
emitted 223 lines, ~150 of it the FPRF classifier, which native NEVER EMITS (Jit64
SetFPRFIfNeeded = `bFPRF && wantsFPRF`, Jit_FloatingPoint.cpp:33-38; bFPRF default false,
GMPE01 has no INI override). We had only the wantsFPRF half. FIX: g_bem_fprf_enabled
(block_cache.cpp, default 0) gates emit_update_fprf_single + emit_fprf_single_from_v128;
JitWasm publishes Config::MAIN_FPRF. IDCT dump: arith bodies 223 -> 68 lines (executed
~165 -> ~15-20); module 81,345 -> 70,892 B. VERIFIED: test_diff_next 3457/0,
test_gekko_next 68/0, MP4 renders crisp (movie content correct), SAB ~14.5 renders, PSO
~30/100%. Residual tear stripe still appears (pace-dependent, shrinking with speed).
NEXT ranked by EXECUTED ops: (a) psq_st U8 executed arm (GQR-const spec — realistic win
now ~25-30%% of loop, NOT the 10x the line-count implied), (b) entry verify+prologue
amortization on self-chain (~120-200 ops/iter), (c) terminator/chain epilogue (~1693
lines emitted; executed portion unmeasured).**

**PM45g 2026-07-31 — SyncGPU CADENCE-INCOMPATIBLE with the RAF slice pump (measured
twice, both wedge modes named).** (1) Boot wedge: ticks strand while the slice's
emu-running gate is false at boot -> CPU deadlocks in WaitForGpuThread (gc=33) — FIXED
in RunGpuLoopSlice (paused path drains + wakes like the fifo-empty fast-skip; fix KEPT).
(2) With that fixed: still gc=52 / ~5fps — the mechanism throttles the CPU to
max_distance ticks PER PUMP INTERVAL (200K/16ms ≈ 2.6% of Gekko); native's GPU loop
wakes the waiting CPU in microseconds, a 16ms RAF pump cannot. MAIN_SYNC_GPU reverted
OFF (finding documented at the Boot.cpp site). CONSEQUENCE: the residual THP upload-tear
stripes (partial-width, intermittent) have exactly two real fixes, both queued: (a) the
speed campaign closing the CPU->GPU lag by pace (how native avoids it), (b) the parallel
GPU worker topology (sub-frame drain cadence off the RAF) — route A from the PM14-era
plan. Working build re-verified post-revert: gc=1168/60s, fps 23.5-26.4, 93.3% renders.
ALSO verified this session with the native XFB dump (587 frames, ~/Library/Application
Support/Dolphin/Dump/Textures): the blue speckled intro scene the user flagged is REAL
MOVIE CONTENT (native frame n000300 identical class) — our render of it is correct.**

**PM45f 2026-07-31 — SESSION CLOSE-OUT: all TEMP instruments STRIPPED (ours:
TextureCacheBase xfb-geom/stitch publishes, WGPUTextureCache band readbacks, probe
xfbgeom/xfbstitch/xfbband fields; native tree: [xfb-copy]/[xfb-fetch] prints, build-oracle
rebuilt clean; KEPT as reusable tools: PROBE_MEM1_PEEK + PROBE_SHOT). SyncGPU experiment:
MAIN_SYNC_GPU=true WEDGES BOOT under the slice-pump topology (CPU blocks in
WaitForGpuThread, RAF-driven proxied-main slices never run the credit/wakeup dance; gc
frozen 33, white frame) — reverted, finding documented in Boot.cpp. Adapting the SyncGPU
wakeup to the pump model = the open item for the residual THP upload-tear. Final clean
state verified: MP4 ~19-28fps renders 93.3% (persistent band GONE; intermittent partial-
width tear remains, timing-dependent), SAB ~13.7 renders, boot intact. Full-hash texture
accuracy shows no attributable fps cost (device thread has headroom).**

**PM45e 2026-07-31 — GREEN-BAND ROOT CAUSE FOUND AND FIXED (native-default divergence);
smaller residual characterized.** Band-layer readback (per-16-row green masks, cells
0x026B38B4/B8/BC + probe xfbband): copy-texture mask == EFB mask at EVERY sample => the
band is drawn INTO THE EFB by the game's own draws — the THP movie's Y/U/V plane textures
were STALE, and the game's TEV YUV->RGB renders stale zero-chroma as green. THE DELTA VS
NATIVE: our libretro default GFX_SAFE_TEXTURE_CACHE_COLOR_SAMPLES=128 ("Fast" sampled
hash, Options.cpp:824 + Boot.cpp:408) vs native default 0 (Safe/full hash) — 128 sampled
points hash-collided across THP frames whose changes the samples missed, so the texture
cache kept boot-era zero rows forever. FIX: default -> 0 both sites. VERIFIED: the
always-banded Peach/DK scene (3 consecutive runs) is now CLEAN; fps unchanged (~23-29).
RESIDUAL (new, smaller, distinct signature): intermittent PARTIAL-WIDTH right-side
stripes, ~10-12 rows (45s/55s shots) = upload TEARING: with full hashing every change
re-uploads, and the device thread lags the CPU by up to a frame at ~35% speed, so a
re-upload can catch a THP strip MID-DECODE — everything right of the decoder's write
cursor is stale/zero for that strip. Native avoids it by PACE (GPU keeps up => draws
processed before the planes are rewritten), not by different logic. LEVERS: (a) close the
speed gap (the 60fps campaign — the residual shrinks to zero as the lag closes), (b)
SyncGPU semantics (FIFO backpressure) if exactness is wanted before full speed. STRIP
LIST still pending: xfb-geom/xfb-stitch/xfb-band SAB publishes + probe fields + PROBE_
MEM1_PEEK (ours), [xfb-copy]/[xfb-fetch] fprintf + build-oracle rebuild (native tree).**

**PM45c 2026-07-31 — band CORNERED: stitch telemetry (per-container cnt/rect/emptyN,
cells 0x026B389C-38B0 + probe xfbstitch) reads ALL ZERO across the movie while fetches
ran 1646x => StitchXFBCopy NEVER RUNS: GetXFBFromCache returns the VRAM XFB COPY ENTRY
directly (is_xfb_container=false fast path) and THAT texture is what presents. Container/
RAM-decode layers are NEVER presented (kills PM45b's container theory). => The green band
lives IN the XFB copy texture itself, i.e. the [WGPU C1] EFB->XFB BlitToTexture output
(WGPUTextureCache.h ~306) or its consumption by the present blit. The YUYV-zero color
signature + Dawn's lazy-zero-init of textures suggests: rows of the copy texture that the
C1 blit does NOT draw stay ZERO, and IF the copy texture carries YUYV-interpreted bytes
at present time, zero rows decode green. NEXT READS (in order): (1) does the XFB copy
entry's texture store RGBA or YUYV-in-RGBA, and does the present path (ShowImage/C1)
apply a YUYV decode? (2) the C1 blit's render-pass LoadOp + viewport/scissor + drawn rect
vs the 640x480 texture (any path that draws <480 rows leaves zero rows); (3) why ~14
INTERIOR rows intermittently (two copy entries double-buffered — per-entry blit rect).
Suspects REFUTED so far, with the killing datum: copy geometry (bit-identical to native,
xfbgeom vs native prints), CopyEFB MapAsync race (efbram=0/0/0 in movie), RAM live decode
(RAM uniform 0x01FE01FE, wrong color), container baked-green (stitch never runs), EFB-
direct A/B (stale arm, presents nothing, reverted). TEMP INSTRUMENTS TO STRIP when done:
ours = TextureCacheBase xfb-geom/xfb-stitch SAB publishes + probe xfbgeom/xfbstitch/
PROBE_MEM1_PEEK; native tree = [xfb-copy]/[xfb-fetch] fprintf (~/gc_refs/dolphin-upstream
+ rebuilt build-oracle).**

**PM45d 2026-07-31 — hunt state: ALL structural layers read clean; the YUYV-signature
inference is now CONTRADICTED (stitch counters=0 => no container was EVER created in the
run => no TexDecoder_DecodeXFB in the presented chain => nothing decodes YUYV => the
band's green is a DIRECT RGBA value, source unknown). C1 BlitToTexture read: fullscreen
triangle, full-dst viewport, LoadOp_Clear, complete coverage — clean. sab-present page
race can only produce BLACK bands (assign-zero window), not green. Per gate #8 the
contradiction ends hypothesis-driven probing. NEXT SESSION FIRST MOVE (mechanical corner):
add a TEMP per-16-row band hash readback of (1) the XFB copy entry texture post-C1-blit,
(2) the EFB color texture at copy time, published via SAB; one run tells which layer FIRST
contains the band; then diff that layer's writer vs native. Candidate not yet eliminated:
the EFB itself contains the green band at copy time (game-drawn via a broken texture
upload — THP strip textures — or a pass-clear artifact), which would move the bug to the
texture-upload/hash path. fps unchanged ~23-29; all TEMP instruments still in tree (list
in PM45c).**

**PM45b 2026-07-31 — green-band: geometry EXONERATED by native diff; band localized to the
CACHED XFB CONTAINER layer; two suspects remain.** Facts (all measured this session):
(1) NATIVE oracle instrumented (TextureCacheBase [xfb-copy]/[xfb-fetch] prints, still in
~/gc_refs/dolphin-upstream, build-oracle REBUILT — STRIP LATER): copies dst=27cc00/1e6c00
w=640 h=480 stride=1280 nby=480 yscale=1.0, fetches identical. (2) OURS (SAB cells
0x026B3874-3898 + probe field xfbgeom — TEMP): cp=27cc00|1e6c00/640x480/1280/480|yscale256
ft=same — **BIT-IDENTICAL to native. Copy geometry/coverage NOT the bug.** (3) mem1-peek
(new PROBE_MEM1_PEEK hook): guest XFB RAM = UNIFORM 0x01FE01FE at band AND control rows,
both buffers (the page's old "CRASH slot 0x1fe01fe" at 0x801e6d34 is just XFB memory —
0x801e6c00+0x134, not a crash). Uniform RAM cannot paint a BAND => the band is BAKED in
the cached XFB CONTAINER texture (GetXFBTexture creates it ONCE — at boot RAM was ZEROS,
YUYV-zero decodes GREEN — and re-uses it; stitch overlays the movie each frame; band rows
= rows never re-covered IN THAT CONTAINER). Intermittence fits DOUBLE-BUFFERING: two
containers (27cc00/1e6c00); 50s shot banded, 70s clean => likely ONE container has the
baked band. VideoCommon stitch logic covers all 480 rows and its hash gate always passes
(RAM constant) => remaining suspects: (a) OUR WGPUTexture::CopyRectangleFromTexture /
ScaleTexture dropping rows on the container blit (validation/usage hazard — escope now
reads 0x101=NoError-callback, benign on its face), (b) the C1 present blit's display_rect
V-mapping (GetDisplayRectForXFBEntry offsets). REFUTED this session: copy-coverage gap,
CopyEFB MapAsync race (efbram=0/0/0 — path not taken in movie), RAM-layer live decode
(RAM uniform + wrong color for green), EFB-direct A/B (arm presents nothing — stale
experiment, reverted). NEXT (one instrument): SAB-publish per-stitch dstrect + container
entry addr + per-present source container addr; one probe correlates band-frames with
container + stitch rects => the faulty layer falls out. Then fix native-exact. ALSO:
strip the TEMP instruments (ours + native tree) after. fps unchanged ~23-29.**

**PM45 2026-07-31 — MOVIE GREEN-BAND ROOT-CAUSED TO THE XFB STITCH BASE LAYER (user
report; screenshot-driven).** User's live run showed a green striped band across the movie.
Verified with probe screenshots (PROBE_SHOT): movie content is CORRECT (Peach/DK, Wario/
Luigi frames) — the band is a ~14-row strip. Pixel extraction from the PNG: band colors
(0,150,0)/(30,255,30) = EXACTLY YUYV-with-zero-chroma -> RGB. Chain: GetXFBTexture
(TextureCacheBase.cpp:1880) builds the XFB container by decoding guest XFB RAM (YUYV) as
the BASE layer, then StitchXFBCopy overlays VRAM copies; our XFB RAM is NEVER written
(efbram counters 0/0/0 in this scene — XFB-copy-to-RAM path not taken) so RAM = boot
zeros = green base; the band = a strip the VRAM copies DON'T cover. Native's copies tile
the full XFB; ours leave a gap => copy-GEOMETRY delta (rect/stride/y_scale accounting in
the copy entries vs the stitch), NOT throughput. Scene-dependent (70s frame has no band).
NEXT INSTRUMENT: publish XFB fetch (addr/h/stride) + per-copy covered ranges via SAB cells
(worker EM_ASM is invisible — PM28 rule) + extend the probe's xfb field; diff coverage vs
the fetch range; then fix the geometry at the copy site. ALSO LANDED THIS PM (correct-by-
construction even though not this band's root): the EFB->RAM async-encode flush race fix —
AbstractStagingTexture::ReadTexels made virtual; WGPUStagingTexture defers the guest-RAM
write to the MapAsync callback when the encode hasn't landed (WGPUEfbEncodePending
handshake, orphan-safe on staging reuse/destruction). Kills the stale/zero-band class for
board scenes that DO use EFB->RAM copies (the PM38 block-garbage lead). Probe post-fix:
MP4 ~23-29fps, renders, conformance untouched (JIT unchanged). FALSE-ATTRIBUTION RECORD
(gate #6): I first pinned the band on the CopyEFB MapAsync race — refuted by efbram=0/0/0
(the path never ran); the pixel data + stitch read gave the real chain.**

**PM44 2026-07-31 — DUAL-ARM SINGLE-SPEC (v9b) LANDED: MP4 ~21 -> ~24-27fps (+20-25%,
deopt=0), all 3 games render.** Oracle-driven (user directive): twin PC samplers at matched
gc windows re-confirmed the MP4-movie limiter = __THPDecompressiMCURowNxN alone (69.8% of
our guest time vs native 13.3% at 76 gc/s = ~20x; every other fn at the 4-6x norm; native
64% idle). New measuring instrument: test_gekko_next `idct_wasm_dump` emits the EXACT
53-instr IDCT bdnz loop (disassembled from the byte-identical decomp ISO; 8x psq_l GQR0
float, 34x ps arith, 8x psq_st GQR6-U8, bdnz) under production config -> wasm-dis cost
attribution. FINDINGS CHAIN: (1) dump artifact trap: a null g_hle_hook_query makes the
emitter wrap EVERY op in Flush+HLE-prologue+ReloadAll (~10x blowup, kills all Single repr)
— dump tests MUST install a hook query (fixed in the test; production always had one).
(2) Corrected dump: butterflies scalar because volatile f0-f13 live-ins re-enter Double
each self-loop activation (spec v4 stable-half-only); the 4 FMAs = ~3.7K wasm lines EACH
(software-FMA), stores ~1.1K, loads ~850. (3) v8 (assume volatiles, 3-strike deopt):
emit-mix improved but fps FLAT — genuine ~0.5/s flaps (MusyX doubles volatiles) + sticky
force-double + recompile-in-the-bits-clear-window permanently pessimized exactly the hot
blocks (deopt ring all IDCT pcs). Policy tuning (v8b threshold->never) could not fix a
per-entry-BIMODAL property. (4) **v9 DUAL-ARM: emit ps-block bodies TWICE under the entry
guard — singles arm (ALL FPR live-ins assumed Single -> f32x4/relaxed_madd) + plain Double
arm; per-ENTRY selection, zero deopts/evictions, no compile-time mask timing. IDCT emit
37.6K -> 21.3K lines, all 4 FMAs relaxed_madd.** (5) v9-volatile probe: +25-40% gc but
BLACK canvas — the shadow mask is NOT trustworthy for volatiles (writers outside the
powerpc-next flush path — legacy region bodies / non-FP-classified interp — leave stale-SET
bits; singles arm narrowed a genuine double; pn showed 0x7C100000). Stable-half bisect
rendered clean = structure sound, volatile TRUST at fault. (6) **v9b: entry VALUE-VERIFY —
each assumed volatile also passes the lfd-tri-state round-trip (widen(narrow(x))==x,
NaN-exact) at the guard; genuine doubles route to the Double arm. RENDERS + FAST.**
VERIFIED: test_diff_next 3457/0; test_gekko_next 68/0 incl. 3 NEW singles-arm execution
cases (psq_l->ps_add->psq_st chain, ps_mr->stfs, ps_sum1 alias — the standard suite runs
lc_base=0 = Double arm only, so singles-arm semantics were previously conformance-blind);
MP4 93.3% non-black, IDCT share 70.4% -> 64.3% at 24.3 gc/s (~15x native, was ~20x);
SAB ~13-16fps renders; PSO ~30fps renders. NEXT (ranked, from the v9 dump): (a) psq_st/psq_l
GQR-CONSTANT specialization (runtime-GQR dispatch = ~725/850 lines per op, now the dominant
emitted cost; GQR6=0x3d043d04 known at emit -> fixed U8 encode ~40 lines; guard like the
spec pattern), (b) entry-verify cost on self-loop re-entries (~12 ops/lane/volatile per
iteration — consider verifying once + arm-local chain), (c) FPRF narrowing (PM23b).**

**PM43 2026-07-31 — STRIP AUDITED CLEAN (14-agent adversarial workflow) + ps_sum1 FD==FA
ALIASING BUG FOUND AND FIXED (red-green).** The audit's 5 strip-site reviewers found zero
defects in the stripped paths (stack-balance + emit sequences verified). Its sweep surfaced
3 pre-existing issues: (1) **ps_sum1 emitted the fc.ps0->fd.ps0 copy BEFORE emit_sum read
fa.ps0; with FD==FA both are the SAME wasm local (fpr_reg_cache ps0_local_idx =
m_local_base + preg) -> ps1 = c.ps0+b.ps1 instead of a.ps0_old+b.ps1** (interpreter reads
all inputs pre-SetBoth). Proven live red-first: new test_gekko_next cases ps_sum1_basic
(control, passed) + ps_sum1_fd_aliases_fa (FAILED with exactly the predicted 12.0-vs-8.0),
then fixed by emitting sum-first (alias-safe for every FD/FA/FB/FC overlap: sum writes only
fd.ps1, distinct lane locals) — 64/0 + test_diff_next 3457/0 post-fix; MP4 probe unchanged
(~20-23fps, 93.3% non-black, deopt=1). ps_sum0 arm was already safe (parks into
LOCAL_FMA_A/B pre-write). (2) LATENT, not fixed: legacy guests/powerpc gekko_emit.cpp:110
emits an ungated absolute i32.load of SAB cell 0x02500020 ([indirect-base 2026-07-07]) —
OOB in 32MB test harnesses for test_gekko/test_perf_t1 MEM1 fast-path cases (production
unaffected; powerpc-next bakes mem1_base as a constant). (3) tests/CMakeLists.txt stale
64MB-rationale comment updated (the LR-shadow-ring it cited is long gone). AUDIT LESSON:
emitted-helper lane-local aliasing (FD==FA/FB/FC) is a standing hazard class for every
multi-output ps op — audit read-before-write order whenever an emit writes one lane of a
register it also reads.**

**PM42 2026-07-31 — PM36/37 DIAG STRIPPED; CONFORMANCE HARNESS UNBROKEN (root-caused);
CLEAN 3-GAME BASELINE.** The `run.mjs` hard-error (mem-oob+404, flagged PM40) was NOT a
harness issue: the 404 was only the favicon; the trap was ppc_emit.cpp's `[m00-hunt PM37
TEMP]` HOST-side mem1_base publish (`*(volatile u32*)0x026B3818 = mem1_base` on EVERY block
emission, ungated) — 0x026B3818 = 40.6MB > the test's 32MB INITIAL_MEMORY -> wasm i32.store
traps. (Located by running the emscripten test .js directly under node for a real wasm stack
trace, then wasm-objdump -d at the fault offset: `i32.const 40581144; i32.store`.)
test_gekko_next "passed" only because its build was a day stale. STRIPPED (all [m00-hunt
PM37 TEMP] + [single-spec TEMP diag] emission-split/failing-bits): ppc_emit.cpp mem1 publish
(3810/14/18) + emission-split (33EC/33F0) + guard failing-bits (33F8); jit_load_store.cpp
pinned stfs @0x800BB990 (3800-380C/3824-382C/3840), psq_l b00 pin @0x800BB46C (3830-383C),
psq_st m00/cat pins @0x800BB90C/0x800BB4DC (37C4-3820); jit_paired.cpp ps_sum0 pin
@0x800BB8F4 (37B4-37C0). KEPT (feature/instrument): single-spec mask 33E0 + deopt 33E4
(JitWasm.cpp:471/498 consumes), deopt count+ring 33F4/3400 (host-side, event-driven,
acceptance signal), emit-time simd census 33D0-DC (g_bem_lc_base-gated, zero runtime cost,
the ps-emit campaign's metric), and the flush-before-park FIXES in emit_stfs/stfsx.
VERIFIED: test_diff_next 3457/0 + test_gekko_next 62/0 on fresh builds; canonical 3-step
rebuild; clean baselines — MP4 ~21fps (19.8-22.8 steady, 93.3% non-black, deopt=1),
SAB ~14-15fps climbing (78.3% non-black), PSO ~30fps (100% non-black). All three render;
strip perf-neutral (within drift band). Conformance guard is LIVE again for the
paired-single emit-quality campaign (PM39/40's ranked next lever).**

**PM41 2026-07-24 — AUDIO DEVICE SEAM CONFIRMED EXACT TO NATIVE (correctness-first, native
dual-core as the rule; user directive "emphasize correctness, use native for the rules").**
Method: the oracle build (`~/gc_refs/dolphin-upstream/build-oracle/dolphin-emu-nogui`
dual-core, CPUThread=True CPUCore=1) emits `[axei-trace]` device events. Native MP4-movie
cadence (~20s): 9744 DSP interrupts, split INT_DSP=3876 / INT_ARAM=1992 / INT_AID=3876,
AID-fire NumBlocks UNIFORMLY 20. Added matching SAB counters to our DSP::GenerateDSPInterrupt
+ AID-fire site and compared:
  - NumBlocks = 20 (ours) == 20 (native) — IDENTICAL.
  - INT_DSP:INT_AID = 1.00 (ours) == 1.00 (native) — IDENTICAL (MusyX invariant).
  - INT_ARAM = 1992 (ours) == 1992 (native) — IDENTICAL. Our phase-snaps prove ARAM PLATEAUS
    at 1992 (guestRetrace 993->1570, ARAM frozen) = the movie's audio fully streamed; AID
    keeps growing. So the earlier apparent aram:aid ratio gap (0.39 vs 0.51) was a pure
    NORMALIZATION ARTIFACT (different points past the plateau), NOT a bug.
  - AID / guest-VI-field = 3.27 (ours: 3228/993 and 5157/1570, stable) vs hardware-expected
    200 AID/s / 59.94 VI/s = 3.34 — within 2%.
CONCLUSION: the audio DEVICE cadence (AI DMA / DSP / ARAM) is EXACT to native by construction
(shared AudioDMACallback code + identical NumBlocks/ratios) and matches the hardware rate.
The audio choppiness the user reported is PURELY the ~35% real-time SPEED (a throughput
symptom bounded by the paired-single emit quality, PM39/40), NOT a correctness/timing
divergence. Diagnostics stripped (DSP.cpp counters + probe fields removed; source clean).
This is the correctness methodology going forward: native dual-core cadence = the rule;
any divergence is the bug. NEXT native-referenced checks: VIDEO/VI frame pacing vs native,
then a block-PC trajectory diff (trace_diff_gc.py) for guest-execution exactness, then the
render approximations (R1 EFB->RAM nearest-resample, R2 depth, R4 intensity/gamma) vs
native's exact encode.

**PM40 2026-07-24 — SELF-LOOP FUSION: IMPLEMENTED, MEASURED, REVERTED (a well-grounded
NEGATIVE result). Hypothesis (from PM39's research #1 + the IDCT-is-a-bdnz-self-loop
finding): fuse a counted bdnz/bdz self-loop into an in-function wasm `loop` with a `br`
back-edge so GPR/FPR values stay resident in locals across iterations (no per-iteration
flush/reload) and the ~76-op chain epilogue + cross-instance return_call_indirect are
removed. IMPLEMENTED correctly (two versions):
  v1 (safe, memory round-trip): Flush + ReloadAll at the back-edge -> gc 867 (--no-liftoff),
     WORSE (the full ReloadAll is heavier than the original live-in prologue load).
  v2 (residency): in-local reconcile (ReconcileToDoubleInLocal promotes loop-carried Single
     FPRs to Double in-local; MaterializeImmediatesToLocals for GPR immediates), NO memory
     round-trip, br back-edge. Correct by construction (cache state identical at loop-top and
     back-edge). CANVAS RENDERS PERFECTLY every config (nonBlack 286720, wgpuErr=0) — the
     fusion is bit-correct on the hot IDCT paired-single path.
SAME-SESSION A/B MATRIX (gc-count/60s, drift-immune, fires on 49 blocks incl. the IDCT loop):
             fusion OFF   fusion ON (all-recon)   fusion ON (live-in-recon)
  --no-liftoff   990            1017                    978
  --liftoff-only 773            778                     774
ALL WITHIN +-3% = NOISE. Self-loop fusion is a WASH. Two evidenced reasons:
  1. Under TurboFan (--no-liftoff / the default-tiered hot path), V8 ALREADY loop-optimizes
     the self-tail-call (return_call to own funcref -> loop), so removing the dispatch gains
     nothing. The user's hot IDCT block tiers to TurboFan, so fusion can't help their steady
     state.
  2. The IDCT's 47%/5x-native cost is the PAIRED-SINGLE OP BODY (conformance-exact NaN
     ladders + ForceSingle/Force25Bit per ps_add/ps_madd/psq), NOT the loop STRUCTURE.
REVERTED cleanly (emit_self_loop_terminal + ReconcileToDoubleInLocal +
MaterializeImmediatesToLocals + detection/loop-wrap/counter all removed); the downcount
block + terminal dispatch are byte-identical to pre-fusion (verified by read), so emitted
wasm == baseline. gc drop 990->770 in the final reverted run is THERMAL (sustained ~20
build+probe cycles this session), not a regression — byte-identical wasm executes
identically; the delta is environmental.
CORRECTED LEVER FOR NEXT TURN: PAIRED-SINGLE EMIT QUALITY on the IDCT body (jit_paired.cpp
ps_add/sub/madd/msub/mul, jit_load_store.cpp psq_l/psq_st). The conformance-exact ladders
emit ~30-70 wasm ops per ps-op vs native's 1 instruction — THAT is the 5x. Path: extend the
single-value speculation / fast-path (PM25-27 got IDCT 33.7x->19.1x) to cover more of the
loop, OR a finite-value fast path that skips the NaN ladder + falls back only on
NaN/edge inputs. Correctness-critical (conformance-covered) — a careful campaign, not a
quick toggle. NOTE: conformance harness (run.mjs test_diff_next) currently hard-errors
(mem-oob + 404) — a harness/serving issue independent of the emitter (the MP4 render
validates the emitter); fix the harness before the ps-emit campaign so it can gate changes.

**PM39 2026-07-24 — EMIT-QUALITY RESEARCH: NATIVE ORACLE GROUND TRUTH (PC sampler,
build-oracle dolphin-emu-nogui dual-core, 32001 samples on the MP4 intro THP movie,
/tmp/native_pc_hist.txt).** Work distribution on native:
- 60.7% IDLE (SelectThread / OS idle thread) — native has MASSIVE headroom; the intro barely
  taxes a real Gekko. Our emulator never reaches idle because the JIT runs the WORK too slow
  to catch up. THE GOAL IS TO MAKE THE ~39% WORK FAST ENOUGH THAT THE EMULATED CPU IDLES LIKE
  NATIVE — not to speed up a saturated core.
- 12.5% DVD (DVDGetDriveStatus/DVDInquiryAsync/HuDvdDataFastRead*) — the THP streams from DVD;
  these are POLL LOOPS. Idle-skip / HLE candidates (native spins here waiting for DMA).
- 11.7% THP video decode: __THPDecompressiMCURowNxN (IDCT, ~8 hot 0x100 buckets across
  +0xe0..+0x14e0), __THPHuffDecodeDCTCompY/U/V (Huffman, hot at +0x334/+0x534/+0x634),
  HuDecodeData. Paired-single + integer inner loops = the PM22-27 IDCT campaign target.
- 5.5% audio: HandleReverb (hot +0x110/+0x210), MixAudio, aramStoreData, THPAudioDecode.
- Hottest single non-idle bucket: OSGetFontEncode+0x1c (0x800b7200, blt-) = a per-frame
  video-mode poll reading VI MMIO 0xCC00206E + OS global 0x800000CC. MMIO-read bound (our
  known slow-path class), NOT arithmetic — an idle/poll-skip or MMIO-fastpath candidate.
EMIT-QUALITY TARGETS, in native-cost order: (1) DVD/video-mode POLL LOOPS (idle-skip: if
we're not skipping these, we burn JIT cycles native spends idle — biggest lever if unskipped);
(2) THP IDCT/Huffman paired-single hot loops (emit quality — bdnz in-block, psq/CR
elision); (3) audio DSP loops. A research workflow (Dolphin Jit64 techniques + V8 wasm
tiering + our-emitter-vs-Jit64 gap + emitted-ops-per-op audit) is running to rank the
emitter-level levers; results append here.

**PM39b — DIFFERENTIAL MEASUREMENT (our PROBE_PC_SAMPLE vs native, SAME scene, decisive):**
the distributions are INVERTED. Native 60.7% idle / 11.7% THP; OURS 12.8% idle / 56.3% THP.
Two hard conclusions:
1. IDLE-SKIP IS ALREADY WORKING — our DVD-poll cost is 2.5% vs native 12.5% (we skip the DVD
   status polls MORE aggressively than native, correctly; idle_ring/streak clock-jump in
   block_cache.cpp:753-767 fires). Idle-skip is NOT the lever. Cross it off.
2. THE LEVER IS ONE FUNCTION: __THPDecompressiMCURowNxN = 47.3% of ALL our guest execution
   (6821/14432 samples) vs ~11% native = ~5x over-representation. +7% Huffman
   (__THPHuffDecodeDCTCompY/U/V). ~54% of everything we run is THP video decode.
DISASSEMBLED THE HOT IDCT BLOCK (0x800df2a4-0x800df378, a bdnz loop): it is ALMOST PURE
PAIRED-SINGLE — ps_add/ps_sub/ps_madd/ps_msub/ps_mul butterflies + psq_l (GQR0 float) +
psq_st (GQR6 quantized) + 2 pointer addi + bdnz. So the emit-quality levers, CONFIRMED by
the actual hot code (not hypothesis):
  (A) bdnz LOOP BODY as one tail-chained unit — the loop re-enters every iteration; if each
      iteration pays a block-to-block dispatch (return to C loop + hash + call_indirect) that
      is pure overhead native pays as one fall-through. Keep the bdnz body chained in-WASM
      (block_cache tail-chain path) or fuse the self-loop.
  (B) PAIRED-SINGLE emit quality (jit_paired.cpp ps_add/sub/madd/msub/mul) — these ARE the
      loop body; every wasm op saved per ps-op multiplies by the butterfly count. The
      single-valued speculation (PM25-27) targets exactly this; re-audit whether it fires on
      THIS loop (was gated/reverted in places).
  (C) GQR CONSTANT SPECIALIZATION for psq_l GQR0 (plain float pair) + psq_st GQR6 (fixed
      quantize) — the codec uses constant GQRs; specializing removes the runtime GQR load +
      type dispatch in every psq (jit_load_store.cpp emit_psq_l/emit_psq_st read the GQR
      every execution).
NEXT: emit-quality campaign on __THPDecompressiMCURowNxN's bdnz loop — (A) first (dispatch
overhead is measurable + broad), then (B)/(C). Measure via PROBE_PC_SAMPLE THP% + gc-rate.

**PM39c — V8 TIERING A/B (decisive, reframes the campaign). Same scene, 60s, drift-immune
gc-count:**
- --liftoff-only (Liftoff FLOOR): gc 767, ~11.5fps
- DEFAULT tiering (the user's real browser, no js-flags): gc 1336, fps climbs 13->21 as hot
  blocks tier up
- --no-liftoff (TurboFan immediate; OUR PROBE DEFAULT, dolphin_render_probe.js:135): gc 1000,
  ~22fps
CONCLUSIONS:
1. DEFAULT BROWSER DOES TIER TO TURBOFAN (~21fps steady, same ceiling as --no-liftoff; even
   beats it on total gc because Liftoff boots faster then tiers hot blocks). The user's
   12.7fps screenshot was a PRE-TIER-UP TRANSIENT, not a stuck-at-Liftoff floor. Tiering is
   NOT a hidden 2x lever — cross it off.
2. Steady-state ceiling is TURBOFAN (~21-22fps). The ~3x to 60fps must come from the emitter.
3. CORRECTION to the research synthesis: it assumed Liftoff (no RLE/CSE) so "op-count IS the
   lever". But steady-state is TURBOFAN, which DOES do redundant-load-elim + store-to-load
   forwarding WITHIN a wasm function. So the emitter levers TurboFan ALREADY FIXES for us
   (duplicate EXCEPTIONS load #4b, CR store-then-reload-within-one-function #2, dead DSI
   guard #5) yield LESS than the raw op-count math predicts. The levers that SURVIVE TurboFan
   are STRUCTURAL:
   - #3 BRANCH-FOLLOWING / longer blocks — collapses cross-instance return_call_indirect
     boundaries (V8 NEVER inlines cross-module calls; the per-block-module tax). Every bdnz
     iteration of the IDCT loop pays a full chain epilogue + a cross-instance indirect call
     that TurboFan cannot eliminate. THE top structural lever. ppc_analyst.h:41
     m_enable_branch_following exists, defaults false, never consulted.
   - #1 rc.Flush before the slow-arm host import (jit_load_store.cpp:459) — TurboFan must keep
     the stores (the host call may read gpr[]); narrowing to the slow arm removes real work.
     WARNING: the branch-path version LOST (17.9->15.3, 2026-07-23); A/B in isolation.
   - Paired-single loop-body quality (my B) + GQR specialization (my C, gated g_bem_lc_base=0)
     — the IDCT loop is ~pure paired-single; fewer real ops per ps-op survives TurboFan.
PROBE NOTE: --no-liftoff understates BOOT (real users Liftoff-boot faster) but MATCHES
steady-state ceiling; keep it for clean deterministic emitter A/B (no tier-up transient).
REVISED NEXT: implement branch-following (#3) — the one structural lever that attacks the
IDCT bdnz loop's per-iteration cross-instance boundary. First: confirm whether the IDCT
bdnz self-loop currently pays a cross-instance return_call_indirect per iteration or is a
merged region (cheap br back-edge) — that decides #3's ceiling. Measure gc-rate under
--no-liftoff.

**PM38b 2026-07-24 — R1 EFB->RAM COPIES IMPLEMENTED + ENABLED.** The chain, all landed and
built clean (probe: canvas intact, wgpuErr=0, fps ~18-23):
1. WGPUGfx::FlushPendingWork() public helper (WGPUGfx.h — EndRenderPass+SubmitFrame so a
   readback observes all prior rendering).
2. WGPUTextureCache::CopyEFB full implementation (WGPUTextureCache.h): copyTextureToBuffer
   of the EFB src_rect (color RGBA8 or depth Depth32Float/DepthOnly) into a MapRead buffer,
   non-blocking MapAsync (AllowSpontaneous — same pattern as ReadbackAndPresent; a blocking
   pump would hit the documented ASYNCIFY nested-sleep hazard), callback CPU-encodes into
   the staging map buffer in GX tiled layout (bytes_per_row x num_blocks_y) for formats
   R4/R8/A8/G8/B8/RA4/RA8/RGB565/RGB5A3/RGBA8/RG8/GB8 + linear YUYV XFB. Approximations
   hedged in-code: nearest resample (covers scale_by_half+y_scale), gamma/copy-filter/clamp
   ignored, intensity = BT.601 studio Y (derived from params.yuv — I have NOT verified a
   separate intensity bit exists in this tree's EFBCopyParams), depth channel map follows
   TextureDecoder.h comments. Late-callback case writes the staging buffer's previous
   contents (stale > zeros).
3. Config: GFX_HACK_SKIP_EFB_COPY_TO_RAM default flipped to FALSE in THREE places (the
   registered core-option default "enabled"->"disabled" in Common/Options.cpp:~1107 is the
   one that actually wins; also Boot.cpp:479 + Main.cpp:364 fallback defs). VERIFIED LIVE:
   flags cell 0x026B3858 reads 0x11 = bSkipEFBCopyToRam FALSE, bSkipXFBCopyToRam TRUE.
4. RESULT ON THE INTRO/MENU SCENE: efbram counters (0x026B384C/3850/3854 entries/readbacks/
   encodes) stay 0 — every copy this scene issues is an XFB copy (is_xfb_copy branch,
   still RAM-skipped by design). The R1 path is DORMANT-BUT-WIRED here; it engages in
   gameplay scenes (the board scenes where the block-garbage textures were reported).
   VERIFY THERE: efbram counters + whether post-menu textures stop garbling.
NEXT: gameplay-scene verification of R1 + the crash characterization + emit-quality 60fps
campaign (unchanged from PM38).

**PM38 2026-07-24 — TRIAGE ROUND (user report: render/audio/crash issues; MP4 intro CONFIRMED
RENDERING in the user's Chrome at 12.7fps). Landed fixes, all verified on a clean 75s probe
(canvas intact, wgpuErr=0, fps ~19-23 peak 22.8):**
1. AUDIO DIAG UNITS (gamecube.html:3405): the page counted BYTES as samples — "69121
   samples/s vs 32000" was a 4x-inflated phantom. Real arrival = 16,575 FRAMES/s vs the
   ~48kHz output rate = the core produces ~35% of real-time audio. Sample production IS
   correctly scheduled on CoreTiming (emulated time; workflow audit traced SystemTimers.cpp
   AudioDMACallback). AUDIO QUALITY THEREFORE RIDES ON THE PERF CAMPAIGN — no audio-path bug.
   (Side note from probe: sink=legacy, worklet not active — check the worklet init if audio
   sounds rough even at speed.)
2. LIBUSB CORE BURN KILLED (GCAdapter.cpp Init early-return under __EMSCRIPTEN__): the
   adapter context event thread busy-spun 100.0% OF A FULL CORE for the entire capture
   (worker_8, flagged PM16, now fixed — browser build has no USB).
3. RENDER-GAP FLIPS (WGPUMain.cpp): bSupportsPaletteConversion=false (the palette path was a
   triple no-op producing BLACK entries: uber-substituted shaders + UploadTexelBuffer=false +
   AbstractGfx::Draw empty); bSupportsBBox=false (zeros-returning stub + no storage buffer in
   the WGSL — fallback gives sane defaults).
4. DEPTH-COPY BLIT IMPLEMENTED (R2): new util_fs_blit_depth WGSL (textureLoad from the
   Depth32Float EFB view, reversed-Z undone, depth replicated to RGB) + depth-blit
   BGL/pipeline (WGPUGfx.cpp/.h) + wired in WGPUTextureCache is_depth_copy (was: skipped ->
   lazy-zero black shadow/DOF textures). Movie scene issues no depth copies (counter
   0x026B3524); will fire in gameplay.
**CPU PROFILE (this scene, rendering active):** EmuThread 97% busy, wasm-function[13]
(emitted guest code) = 80.1% (was 48% — slowmem collapsed 19x to 0.4%, sleeps 13%->3%,
dispatch 6.5%, trampolines ~5.3%). GPU side = 4.4% of one core. THE 60FPS GAP IS PURE
GUEST-BLOCK EMIT QUALITY; all non-guest buckets combined ~13% cannot yield the needed ~3x.
**FULL RENDER-GAP INVENTORY R1-R15** (workflow wf_acce2715, output preserved at
/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/760f7077-7d93-433b-bbb0-89c76a198c47/tasks/wu7e04v1g.output):
R1 EFB->RAM copies write ZEROS into guest RAM (staging stub — TextureCacheBase.cpp:2396
WriteEFBCopyToRAM memcpys the zero buffer; the old header comment claiming RAM keeps prior
contents was WRONG) = the block-garbage class -> fix sketch: real WGPUStagingTexture
readback (copyTextureToBuffer + MapRead + bounded pump) + CPU GX-tile encode ported from
VideoBackends/Software/TextureEncoder.cpp. R4 intensity/gamma/copy-filter dropped in VRAM
blits. R5 uber WGSL hard-requires dual_source_blending (no fallback variant — total-black
risk on adapters without it). R6 EFB peeks return 0/pokes dropped (game-LOGIC gap — a crash
candidate). R7 ReinterpretPixelData/-Entry no-ops. R10 no frag_depth (ztexture). R14
viewport negative-origin clamp shifts instead of crops.
**CRASH ISSUES: NOT yet characterized** — the [crash-slot-direct] console line is a legacy
transition watch, not a crash. Need a repro: which game/scene/how long. Candidates: R6 EFB
peeks returning 0 to game logic, R1 zero-RAM writes, or a genuine JIT fault post-menu.
**NEXT: (a) R1 CopyEFB implementation (the big render fix); (b) characterize the crash
(long probe into gameplay, watch panic/wild-jump cells); (c) 60fps = hot-block emit-quality
campaign vs the native PC sampler (PM21 protocol) — bdnz in-block loops first; (d) strip
the remaining op.address-gated PM37 emit diag + probe fields.**

**PM37 2026-07-23 — BLACK CANVAS FIXED. MP4 RENDERS REAL CONTENT (93% non-black, sky/yellow
title colors, ~18fps, wgpuErr=0). ROOT CAUSE: WASM SCRATCH-LOCAL 98 COLLISION — the stfs/stfsx
store value (LOCAL_TMP_FPVAL=98, jit_load_store.cpp:57) was parked ACROSS rc.Flush+frc.Flush,
and frc.Flush's lfd tri-state runtime round-trip check (fpr_reg_cache.cpp:268, added PM26/v5)
writes LOCAL_PSQ_T0 == slot 98 — destroying the parked value. Every scalar-FP store whose
flush had a value-unknown register stored FLUSH SCRATCH instead of its value. PSMTXScale's
stfs of scale_x=1.0 stored 0 -> HuSprGrp matrices collapsed (m00=0: x'=const for every vertex)
-> zero-area triangles -> zero fragments -> black. FIX (jit_load_store.cpp emit_stfs +
emit_stfsx): emit the flushes BEFORE converting+parking the value (post-flush the ps0 local is
still valid — a Single-repr rs was just promoted, which rebuilds the pair locals).**
The full post-PM36 forensic chain (each step one canonical loop round; native oracle assets
= MP4 decomp symbols/source + bundled binutils disassembly of OUR ISO):
1. Acquire-gate fix on the FIFO slice (Fifo.cpp:418, relaxed->acquire): NO change (wasm
   lowers all atomic orderings to seq_cst — kept as documentation-correctness). A 20-agent
   workflow audit adversarially REFUTED all 16 transport candidates (consumer-atomics,
   fifo-ram-writers, upstream-diff, video-buffer-reassembly) — transport exonerated.
2. Consumer chunk-scan: the copied chunk in m_video_buffer had the CORRECT 1.0 -> exposed
   that PM36's 'transport loss' inference was wrong; the xfmem write LANDS (read-back 1.0
   right after LoadXFReg) and dies LATER (post-write clobber framing).
3. Canary bisect (bem_xf_canary sites 1-6): transition fingerprint 0x601 = word0 dies
   INSIDE LoadXFReg, culprit params base=0 size=12 — the PNMTX0 load itself; event ring
   showed per-frame [good-load, bad-load, upload(0), bad-load, upload(0)] with NO display
   lists (dlN=0) and NO spurious small XF loads.
4. Producer split at GPFifo::Write32: 1811 loads/min arrive with first word ALREADY 0 ->
   the GUEST (our JIT) wrote 0. MEM1 scan: the game's matrix objects in RAM have m00=0.
5. HuSprGrpData[4] fields all healthy (scale_x=1.0 in RAM); disassembled PSMTXRotAxisRad
   (0x800BB854) from OUR ISO via marioparty4 binutils: per-instruction emit instrumentation
   proved the m00 ps_sum0 (0x800bb8f4) computes 1.0 and its psq_st (0x800bb90c) stores 1.0
   to the rot TEMP. PSMTXConcat (0x800BB460) traced: pinned group-mtx store (0x800bb4dc,
   EA==0x80155C04) stored 0 with a00=1.0, b00=0 from temp @0x801E6AC4 (r4-bound).
6. PSMTXScale (0x800BB98C) `stfs f1,0(r3)` stores 1.0 to 0x801E6AC4 (pinned: 0 zero-stores)
   while Concat's psq_l reads 0 from the SAME EA, SAME host addr (0x1B0FF964 both), same
   thread, both fast arms, no mem1_base rebase (detector: 0 changes) -> only possible if the
   ACTUAL store diverged from the diag — the diag ran before the flushes, the real store
   after -> found the slot-98 alias (LOCAL_TMP_FPVAL == LOCAL_PSQ_T0 == LOCAL_FP_T0 == 98).
ELIMINATED ALONG THE WAY (all A/B'd on the live scene): single-valued speculation
(BEM_SSPEC_DISABLE=1: no change), whole Single-repr machinery (IsSingle()=false: no change),
mem1_base rebase, XF decode, GPFifo transport, DL replay, FTZ semantics.
NOTE the scratch-local map is a LANDMINE: only 4 i32 scratch slots (0=TMP_EA, 1=TMP_VAL,
98, 99) shared by bswap/psq/FP-helpers/flush-checks — ANY value parked across an emitted
helper must audit its scratch usage. Consider dedicating a reserved park slot (new local)
as follow-up hardening.
**NEXT: (a) strip ALL PM36/PM37 TEMP diag (WGPU cells 0x026B3500-3600 + 0x3680-3840 range,
canary/ring in XFStructs+OpcodeDecoding+WGPUVertexManager, GPFifo xf-cap, emit-site
op.address-gated diag in jit_load_store/jit_paired, probe fields oob/strides/xf*/xfl2/xfb/
xfn/xfo/xfi/xfj/xfk) and clean-rebuild; (b) re-baseline perf (gc/s + fps) on the clean
build — rendering now ACTIVE changes the profile; (c) cross-game verify SAB/PSO/240p;
(d) resume the 60fps campaign (bdnz block-boundary items, volatile-reg speculation, GQR
constant specialization) against the clean baseline.**

**PM36 2026-07-23 — BLACK-RENDER ROOT CAUSE FOUND: EVERY VERTEX COLLAPSES TO ONE CLIP POINT
BECAUSE cpnmtx (the position matrix) REACHES THE SHADER AS (0,0,0,tx) ROWS — AND THE CPU-SIDE
XF/CP MATRIX STATE IS THE CORRUPTION SITE (dual-core state-feed class), NOT THE GPU STACK.**
The forensic chain, each step one canonical build+probe round, all on MP4 movie scene:
1. [top-magenta] fragment's FIRST statement returns magenta under a UNIFORM condition
   (`unnamed.bpmem_dither != 0xDEADBEEF`; a gl_FragCoord branch makes textureSampleBias
   non-uniform and Tint REJECTS the module — wgpuErr 0→1658 "Error while parsing WGSL",
   gpuDraw 0/1951; uniformity is a hard constraint on all future WGSL probes). Result:
   canvas nonBlack=0 with 2001 draws executed, 0 errors → fragments never generated.
2. [cull-none + depth-always retest] PM31/32's eliminations were INVALID (run with
   black-on-black fragments = unobservable signal). With top-magenta: still nonBlack=0
   → cull and depth NOW validly eliminated.
3. [fullscreen-vs] override gl_Position with a vidx%4 fullscreen-quad corner → MAGENTA,
   230,400px rows 0-479 → everything downstream of position WORKS; computed positions
   are the killer.
4. [z-only] keep computed x/y/w, clamp z=0.5w → still black → NOT the WebGPU z-in-[0,1]
   convention; x/y/w themselves degenerate/offscreen.
5. [uniform-as-color] (visible-channel trick: fullscreen positions + encode data in the
   clipPos interpolant, fragment paints it): cpnmtx[0] NONZERO (green), components&2=0
   (else-branch = cpnmtx path, same as PM34 replica assumed).
6. [rawpos sign-encode] fetched rawpos INTERPOLATES across samples (255/191/127/31 red
   ramp; y=+48 const, z=0) → VERTEX FETCH 100% HEALTHY (stride 20 verified both sides:
   strides=14000f/14010f; oob arithmetic in-bounds: base_vertex 5706-5912, 16MB buffer).
7. [matrix-magnitude encode] R=|cpnmtx0.xyz| sum, G=|cproj0.xyz|*320, B=|cpnmtx0.w| →
   (0,255,255): cpnmtx row0 xyz IDENTICALLY ZERO, w>=1, cproj HEALTHY → collapse is the
   MODELVIEW matrix, projection fine.
8. CPU-side pn cells (WGPUVertexManager.cpp:396) had shown it all along: pn=0/43190000
   → CPU struct uploads cpnmtx row0=(0,0,0,153.06). Upload path CLEAN; corruption is
   UPSTREAM of VertexShaderManager's memcpy (VertexShaderManager.cpp:292-296:
   posnormalmatrix <- xfmem.posMatrices[matrix_index_a.PosNormalMtxIdx*4]).
9. [xf-diag] MatrixIndexA.Hex = 0x3CF3CF00 = EXACT POWER-ON DEFAULT (PosNormal=0, all
   tex=60 — a live scene would have set tex indices; suggests CP MatrixIndexA writes
   NEVER reach g_main_cp_state). xfmem.posMatrices healthy-row scan: 4 rows with
   nonzero xyz, FIRST AT ROW 1 (selected matrix needs rows 0-2; row0 xyz all zero).
   Raw words: w3=153.06, w4=0, w7=402.0, w8=0, w12=0 → row1=(0,?,?,402). Not a clean
   +4-word shift (w4=0). The XF pos-matrix content layout is wrong/partial AND the CP
   index state is frozen at default.
**PM36 ADDENDUM — the "shift" was wrong; it is EXACTLY ONE WORD: the FIRST XF payload
word arrives as ZERO.** Full words 0-15 dump: [0,0,0,153 / 0,1,0,402 / 0,0,1,0 / 0,0,0,0]
vs true identity+translate(153,402,0) = [1,0,0,153 / 0,1,0,402 / 0,0,1,0] — words 1-11
PERFECT, word0 only: 1.0 -> 0.0 (diagonal zeros made shift vs first-word-zero ambiguous
until the full dump). Path split (XFStructs.cpp TEMP counters): 2924 IMMEDIATE LoadXFReg
loads, last = addr 0 size 12 (GXLoadPosMtxImm PNMTX0); ZERO indexed loads. Decoder
(OpcodeDecoding.h:157-175) and LoadXFReg (XFStructs.cpp:201) verified upstream-correct →
THE STREAM BYTES THEMSELVES carry 0 where 0x3F800000 belongs. Producer side = guest
gather-pipe writes (GXLoadPosMtxImm: cmd byte + cmd2 = 5 bytes, then the matrix floats
stream at UNALIGNED pipe offset 5 via FP stores) → suspect = our JIT gather-pipe /
GP-ring transport dropping-or-zeroing the FIRST FP store after the header (possibly the
first psq_st pair at offset 5; pair = (1.0, 0.0) so a whole-pair kill is also consistent
— m0.y=0 masks it). MatrixIndexA frozen at default is likely the SAME producer bug
killing 1-word XF loads (GXSetCurrentMtx = cmd+cmd2+ONE word) entirely... hedge: not yet
proven — could also be a separate CP-cmd 0x08 issue; xfmem healthy count 4 with row0
partial suggests OTHER matrices land similarly first-word-dead.
**PM36 ADDENDUM 2 — PRODUCER PROVEN INNOCENT; the word dies IN TRANSPORT.** GPFifo::Write32
state-machine capture (GPFifo.cpp, after cmd2==0x000B0000): first payload word = 0x3F800000
(1.0) on 3016 triggers vs 3017 consumer-side loads seeing 0. So: guest code ✓, JIT psq_st/stfs
emit ✓, GPFifo::Write32 input ✓ — the 1.0 is lost between FastWrite32's gather-pipe buffer and
the video-side stream that LoadXFReg decodes. Phase-snaps show gpRingHead/Tail/Applied = 0 →
the GP ring is NOT the active transport; the video thread reads the CP FIFO from shared guest
RAM. PRIME SUSPECT (unverified): video-side read overtaking the committed write watermark by
one word — reads a not-yet-landed SAB word as 0, pointer advances, never re-read; deterministic
per-frame pumping makes it hit the SAME stream position (the XF payload word0) 100% of the
time. Same bug family as the fixed wp-diverge / gather-drain-race classes (commits 71bf545,
fbcf9f2).
**NEXT:** (a) localize the overtake: in FifoManager::RunGpuLoopSlice/RunFifo path, compare the
read pointer against the CPWritePointer/distance watermark at the moment the XF payload is
consumed; capture readPtr, wpc, distance when LoadXFReg sees word0==0 (consumer-side TEMP in
XFStructs already counts these — add the pointer capture next to it); (b) check
UpdateGatherPipe's chunk commit vs the distance publish ordering (is the 32B chunk memcpy'd
AFTER the distance/wp is bumped? a wp-bump-before-memcpy would expose exactly the chunk's
leading words); (c) fix the ordering (commit bytes BEFORE watermark publish, or fence), then
REVERT ALL PM36 experiments (WGSL top-magenta + clipPos encode + bem_vidx param,
BEM_CULL_NONE/BEM_DEPTH_ALWAYS -> 0, xf-diag/oob-arith/xfl/xfp TEMP cells + probe fields),
clean rebuild, and verify the MP4 movie RENDERS with real colors.
DIAG INVENTORY THIS ROUND (all TEMP, strip later): WGSL top-magenta + clipPos encodes
(WGPUUberShaders.h fn main VS+FS), BEM_CULL_NONE=1 + BEM_DEPTH_ALWAYS=1 (WGPUGfx.cpp —
REVERT to 0), oob-arith cells 0x026B3680-90 (DrawIndexed + CreatePipeline + SetPipeline),
xf-diag cells 0x026B369C-36B8 (WGPUVertexManager.cpp UploadAllConstants), probe fields
oob/strides/xf/xfw.

**PM35 2026-07-23 — MODEL CORRECTED BY THE CLEARREGION-RED BREAKTHROUGH: THE RENDER STACK WORKS
(util clear-DRAWS fill 640x480 red through the full pipeline+pass+rasterizer+present); the broken
object is the GAME (uber-shader) PIPELINE, which validates clean and emits nothing.** The round's
chain: pass-diff tuples proved util clear-draws run PER FRAME (1009/60s, full 640x480 scissor,
SAME pass object as game draws) — so all prior "zero fragments" observations were BLACK clears
painting a black scene (gate #6 correction: PM31-34's zero-fragment model conflated content-black
with absence). [clearregion-red] (forced ClearRegion uniform color red, EFB-direct): rows 0-480
ALL red (307,840 px) = DRAWS LAND. Then, over the red background: game draws with forced-magenta
uber fragment = ZERO magenta (indexed AND an added non-indexed Draw(3) probe — both nothing);
index content VALID (quad strip 1,2,0,3 + restart, probed @0x026B35E8-F0); explicit
push/popErrorScope around game draws = NoError (0x101); dual-source-blending SUPPORTED+requested
(has_dsb @0x026B35F8 = 0x11). FINAL STATE: the uber-pipeline draws are valid-and-fragmentless
while util-pipeline draws work — the difference is confined to {uber shader modules, uber
pipeline layout, per-config pipeline state}.
**NEXT (the closing bisect, ~4-6 steps with a working reference on one side):** build ONE hybrid
pipeline at init and Draw(3) known vertices per frame; bisect the ingredient: (a) uber modules +
uber layout + MINIMAL state (no blend, TriangleList, no depth attachment variant) — draws? state
mapping is the bug; doesn't? (b) swap the uber FRAGMENT for a trivial passthrough (keep uber
vertex + layout) — draws? the uber fragment module is the bug (its @blend_src outputs vs
non-dual-src blend states interaction is the prime suspect: pipelines whose blending_state has
use_dual_src FALSE but whose fragment ALWAYS declares @blend_src(0)/(1) — Dawn may require the
blend to USE Src1 factors when the shader declares blend_src, or silently mask output 0 —
CHECK Dawn's dual-source validation rules for exactly this combination FIRST, it may be a
documented behavior); doesn't? (c) swap the uber VERTEX for a passthrough — names the vertex
module. All prior TEMP diag cells 0x026B3500-3600 + probe fields inventoried for the final strip.

**PM34 2026-07-23 — CLIP COORDINATES PROVEN VALID (C++ transform replica: vertex0 clip =
(-0.469, 0.258, w=1.0) — DEAD CENTER, in-volume) and still ZERO fragments; the stripe (row 480,
pure white, full-scissor) is the ONLY draw output ever observed = the working reference to diff.**
This round: thread-identity probe = init/pipeline-create/draw ALL on one thread (1104ce6c —
per-thread handle-table hypothesis DEAD); raw viewport = clean (0,0,640,480) (origin-bias
hypothesis DEAD); stripe analysis (EFB-direct + row scan): firstRow=lastRow=480, samples all
255,255,255 — one full-width white line at exactly viewport-bottom, written OUTSIDE the game
scissor ⇒ from a util pass (likely ClearRegion's clear-DRAW with its own viewport/scissor);
clip-replica (C++ mirror of cpnmtx*p then cproj, probed real inputs @0x026B35B4-BC ->
@0x026B35C0-C8): valid in-volume coords w=1. NOTE stale-build trap hit once mid-round (5 compile
errors + link packaged stale objects — the grep -c pipeline masked failure; ALWAYS check the
error count line before trusting a probe).
**COMPLETE STANDING LEDGER: every semantic layer is proven correct** (geometry, transform, clip
coords, uniforms, layouts byte-exact, write masks, viewport/scissor, cull=None tested,
depth=Always tested, forced-solid shader tested, same texture, same thread, submitted encoders,
zero validation errors) **and no game fragment has ever landed. The one landing write is the
row-480 util draw.**
**NEXT (for the successor, exact):** (1) instrument the util CLEAR-DRAW path (ClearRegion,
WGPUGfx.cpp:756 SetPipeline util_clear + its viewport/scissor/pass) — capture its FULL pass
config (encoder ptr, pass ptr, viewport, scissor, pipeline handle) at ITS draw, and the SAME
tuple at a game DrawIndexed; diff field-by-field — two draws, one lands, one doesn't, finite
config space; (2) if identical: dump the FIRST game draw's pass via Dawn's toggles
(dump_shaders/disable_symbol_renaming via instance descriptor) or wrap the draw in
push/popErrorScope explicitly; (3) the dawn/emdawnwebgpu 4.0.10 version-specific behaviors
(indirect-draw-index quirks, base_vertex support on Uint16 draws — CHECK: DrawIndexed passes
base_vertex as i32; WebGPU baseVertex is signed ✓ but verify emdawnwebgpu marshals it — a
mis-marshalled HUGE baseVertex would read degenerate vertices GPU-SIDE while the CPU arena
holds real data — THIS FITS EVERYTHING TOO: valid CPU-side vertex + garbage GPU-side fetch;
test = draw with base_vertex folded into base_index instead (rebase indices), 1-line in
CommitBuffer/DrawIndexed).
Diag cells this round: 0x026B359C-35C8 (TEMP). EFB-direct reverted; tree at shipping config.
ADDENDUM same round: basevertex-fold test RUN (byte-offset buffer binds + bases 0, toggle
BEM_BASEVERTEX_FOLD in WGPUVertexManager.cpp, mechanism kept at 0 for re-test) = STILL BLACK —
the baseVertex-marshalling hypothesis is dead too. The util-draw-vs-game-draw pass-config diff
(item 1 above) is now THE single remaining discriminator: one draw provably lands (the white
row-480 line), thousands don't, and every semantic difference between them has been eliminated
except their concrete pass/pipeline/binding tuples at the wgpu call boundary.

**PM33 2026-07-23 — TOTAL ELIMINATION REACHED: zero fragments under MAXIMAL overrides; the
remaining search space is the emdawnwebgpu PER-THREAD OBJECT-TABLE seam between init-created and
draw-thread-used handles.** This round (all toggles REVERTED, tree clean, verified by wasm string
grep + 0-error rebuild): layout audits CLEAN (workflow wyjib6znj: WGSL VSBlock/PSBlock byte-exact
vs ConstantManager.h — projection @128 both sides, sizes 4112/1536 exact incl. bind sizes +
dynamic-offset order; vertex-attribute layout exact vs uber-VS @locations 0-15, the
bSupportsDynamicVertexLoader trap does NOT fire); cull_mode=None forced — black;
depthCompare=Always — black; dyn-offset swap — inconclusive-black (reverted, spec-wrong);
uniform CONTENT verified REAL: cproj row0 = 2D-ortho (0x3b638e39≈2/576, -1.0), cpnmtx live
(identity early, rotated later); **COMBINE-ALL (magenta BOTH fragment outputs + cullNone +
depthAlways + EFB-direct readback) = STILL exactly 640 nonBlack (one row)** — with culling off,
depth always-pass, and every would-be fragment forced solid, ZERO fragments exist. NOTE: the one
1-row stripe means ONE draw-like write DOES land — identify WHICH (its config is the working
reference!). Shader compile threads = 0 verified (bSupportsBackgroundCompiling=false →
GetShaderCompilerThreads()=0 → pipelines compile synchronously on the video thread).
**REMAINING HYPOTHESIS SPACE (ranked):** (1) emdawnwebgpu per-thread handle-table mismatch:
WGPUGfx init (device, BGLs, buffers, samplers) runs on ONE thread (proxied-main at backend init);
pipelines + draws run on the gpu_thread — every cross-created handle (m_uber_bgl_uniforms passed
into pipeline layouts, m_uniform_buffer into bind groups, etc.) dereferences the WRONG per-thread
table entry — some combination lands on type-valid-but-wrong objects with NO validation error
(the readback path works because ITS objects are all same-thread-created). TEST: publish
pthread_self() at (a) WGPUGfx init, (b) CreatePipeline, (c) DrawIndexed — any mismatch = the
answer; fix = create-on-first-use-per-thread or route all wgpu calls to one thread. (2) The
1-row writer identification (cheap: it renders row 0 only — likely the util CLEAR-REGION or a
1px-high scissored draw — instrument BlitToTexture/ClearRegion rect + the row's PIXEL VALUES).
(3) Dawn maplike state on the pass object across EndRenderPass timing. The stripe (2) is the
cheapest thread to pull: ONE working write exists — diff its object-creation THREADS against a
game draw's.

**PM32 2026-07-23 — EVERY RUNTIME STAGE PROVEN REAL; the remaining suspects are the TWO LAYOUT
CONTRACTS (vertex-attribute layout and UBO struct offsets).** New eliminations this round, each
one-run counter/experiment (all toggles reverted): depth test (BEM_DEPTH_ALWAYS forced
depthCompare=Always — still black); error scopes (none exist — the uncaptured handler is the only
sink, and it counts 0); vertex CONTENT (probe @0x026B3580-88: vertex0 dword0 = 0xc2400000 = -48.0f,
live 16-dword XOR, 4-vert quads stride 0x14 — REAL geometry reaches wgpuQueueWriteBuffer).
Standing ledger: real geometry + live uniforms + color-write-enabled pipelines + executing encoder
draws + same texture as blit/readback + depth Always + zero validation errors + submitted encoders
= ZERO fragments produced. The only mechanisms left that silently produce zero fragments with
valid inputs: (A) the pipeline VERTEX LAYOUT (WGPUVertexLayout built from the native vertex
declaration) mis-mapping stride-20 attribute bytes onto the uber-VS @location inputs — position
reads wrong bytes -> garbage clip coords -> everything clipped (ALSO explains the 07-13
"corrupted-but-visible" era: a smaller offset drift); (B) the WGSL VSBlock/PSBlock UNIFORM STRUCT
layout drifting from C++ VertexShaderConstants/PixelShaderConstants (WGSL align/size rules vs C++
packing — one inserted field after 07-13 shifts everything; projection garbage -> all clipped).
NEXT (mechanical audits, no more runtime bisects needed): (a) diff the WGSL struct field-by-field
against VideoCommon/ConstantManager.h offsets (mind vec4 alignment + u32 packing); (b) diff the
pipeline's WGPUVertexBufferLayout attribute offsets/formats against the native vertex declaration
(VertexLoaderManager current decl) for the stride-20 quad format; (c) the 07-13 commit window on
these two files names the drift. Vertex probe cells @0x026B3580-88 (TEMP).

**PM31 2026-07-23 — ELIMINATION COMPLETE EXCEPT ONE: the draw pass and the blit use the SAME
texture (fbIds 16fdc858==16fdc858) — the last standing candidate is the VIEW SLICE (array
layer / mip) mismatch.** Full ledger, every row counter-proven this session: draws reach
wgpuRenderPassEncoderDrawIndexed (drawPath 2009/0/0/2009 — zero null-pipeline or other bails);
pipelines carry color write masks (wmask 3 None / 52 color-enabled); PS/VS uniforms live
(changing checksums); viewport/scissor 640x480/0-degenerate; zero device errors (SAB-routed
handler); encoder submitted per present (SubmitFrame at ReadbackAndPresent head, WGPUGfx.cpp:903);
attachment texture identity EQUAL at the texture level (draw-pass GetColorAttachment()->
GetTexture() == blit-source GetEFBColorTexture()->GetTexture(), @0x026B3578/7C). Forced fragment
outputs (magenta ocol0; ocol1.a=1 — both verified in-wasm by string grep, both reverted) produced
ZERO visible change. With texture identity equal and draws executing, the ONLY remaining
mechanism: the pass's color VIEW (WGPUFramebuffer::GetColorView) targets a different
baseArrayLayer/baseMipLevel of the 2DArray EFB texture than the blit's SAMPLE view + the readback
copy read (layer/mip 0). NEXT: publish the view-create descriptors (baseMipLevel, baseArrayLayer,
arrayLayerCount, dimension) for (a) the framebuffer color view, (b) WGPUTexture::GetBindingView,
(c) the readback's CopyTextureToBuffer origin — one run names the slice mismatch; the fix is a
1-line view-descriptor correction in whichever creator diverges. STATIC LEAD already found: the
framebuffer color view is created with the DEFAULT descriptor (`wgpuTextureCreateView(tex,
nullptr)`, WGPUTexture.cpp:350) while GetBindingView uses an explicit 2DArray desc
(WGPUTexture.cpp:86-92) — check what the default view resolves to for the EFB texture's actual
layer/mip/sample config (multisampling! if the EFB texture is created MSAA and the blit samples
it as non-MSAA, or vice versa, that's also this class) FIRST. (PM30's null-pipeline model:
REFUTED by drawPath. PM29's "draws overwrite red": REFUTED — ClearRegion painted the black.)
TEMP diag added this round: drawPath @0x026B3560-6C, wmask @0x3570/74, fbIds @0x3578/7C,
uniCk @0x3558/5C — strip with the campaign.

**PM30 2026-07-23 — FRAGMENT-STAGE BISECTION, RECONCILED MODEL: the game draws likely emit
NOTHING (silent null-pipeline early-out); the black frame is CLEAR COLORS.** Evidence this round
(experiments reverted; staleness proven by string-grep of the wasm):
(1) PS/VS uniform XOR-checksums @0x026B3558/5C (uploaded per batch from the shared constant
managers, WGPUVertexManager::UploadAllConstants): LIVE and CHANGING (ffc70549/548c9d1...) — NOT
zeros. Uniforms eliminated.
(2) [magenta] forced the uber fragment WGSL's return to solid magenta (WGPUUberShaders.h; string
verified IN the shipped wasm, grep count 1): ZERO visual change, zero device errors, 2029 draws
submitted — **the game draws' pipelines do NOT execute the header's uber WGSL at runtime.**
(3) RECONCILIATION of PM29's red-clear: only SetAndClearFramebuffer's clearValue was forced red;
ClearRegion (the OTHER clear consumer — util_clear_pipelines, WGPUGfx.cpp:708/:756) still cleared
with the game's colors (black). So "draws overwrite red with black" was WRONG (gate #6 correction)
— the 91% black is REGION-CLEARS, and the draws may paint nothing at all.
**NEXT COUNTERS (exact):** (a) inside WGPUGfx::DrawIndexed: entries vs
wgpuRenderPassEncoderDrawIndexed EXECUTIONS vs early-outs (null pipeline / null pass / null
buffers) @0x026B3560/64/68 — a silent null-pipeline bail is error-free and explains everything;
(b) count CreateShaderFromSource vs CreateShaderFromBinary calls + CreatePipeline successes/
failures @0x026B356C/70/74 (the binary-cache path at WGPUGfx.cpp:1178 "memcpy's straight back" may
serve blobs bypassing the header WGSL, or pipeline creation fails and Dolphin's ShaderCache keeps
a null AbstractPipeline); (c) if pipelines are null: the fix is in the create path (naga/WGSL
validation of the uber pair on THIS dawn version — check the error scope around
wgpuDeviceCreateRenderPipeline, it may swallow errors without the uncaptured handler firing).
Reference next session: the 07-13 A/B dumps /tmp/gcshots (WGPU, corrupted-but-visible) prove the
uber pipeline DID execute then — diff the pipeline-create path against that commit window.

**PM29 2026-07-23 — RENDER-HALF FORENSICS COMPLETE: the black output is the FRAGMENT STAGE
producing black with CORRECT coverage — TEV/uniform inputs are the prime suspect.** Chain of
eliminations, each by counter/experiment (toggles REVERTED to 0 after each run):
(1) device errors: OnUncapturedError rerouted to SAB (count @0x026B3530, type @34, first msg text
@0x3540 — its EM_ASM print was invisible like all gpu_thread prints) = **ZERO errors**;
(2) [efb-direct] present the LIVE EFB instead of the XFB copy (BEM_EFB_DIRECT_PRESENT toggle in
ShowImage) = EFB black too (nonBlack 640/337920 — one row) ⇒ NOT the blit;
(3) viewport/scissor published per pass (@0x026B3548/4C, degenerate count @0x3550) = 640x480/
640x480/0 ⇒ NOT clipping;
(4) [red-clear] force SetAndClearFramebuffer clearValue red (BEM_RED_CLEAR toggle; clear count
@0x026B3554): **nonBlack 640 -> 30,720** — loadOp=Clear covers the WHOLE attachment, so every
clear painted the frame red and 91% ended BLACK ⇒ the game's draws RASTERIZE (correct coverage,
they overwrite the red) with BLACK fragment output;
(5) WGPUTexture::Load is REAL (wgpuQueueWriteTexture, WGPUTexture.cpp:238) — uploads exist;
(6) the fragment shader is the full TEV uber-shader (WGPUUberShaders.h) — it outputs black when
its UNIFORM inputs (TEV regs, konst colors, materials) are ZEROS.
**NEXT PROBE: per-draw uniform content** — publish a checksum/first-words of the PS uniform block
at WGPUVertexManager::DrawCurrentBatch (m_uniform_buffer + offsets, WGPUVertexManager.cpp:346-361)
+ the same for VS (projection matrix zeros ⇒ position path also suspect — though coverage being
correct suggests VS uniforms are fine and the PS block is the zeroed one). If zeros: chase
PixelShaderManager/VertexShaderManager dirty->upload wiring in the WGPU vertex manager (the
07-13 corrupted-but-visible -> now-black regression window = the device/thread migration; a
constants side lost its upload or reads the wrong thread's manager state).
Diag cells this round (TEMP): 0x026B3530-3554 + probe fields wgpuErr/vpState.

**PM28 2026-07-23 — BLACK-CANVAS FORENSICS: the DELIVERY half is FIXED (SAB-present landed);
the remaining blackness is INSIDE the WGPU render pass.** User-visible symptom: gamecube.html
black canvas at 12.6fps during the MP4 movie (screenshot), READY=false (= the dead takeover gate,
harmless). Chain walked with collision-checked SAB counters (NOTE: 0x026B1B18-34 are TAKEN by
Fifo.cpp — first counter placement collided and read garbage; present-diag cells live at
0x026B3500+): Video_OutputXFB 3298/run -> ViSwap 2650 -> Present 2060 (presentGate flags 0x9:
WGPU IS the live backend, xfb_entry nonnull) -> ShowImage/Readback/map-cb/publish 1030/1030/1030/
1030 -> CopyEFBToCacheEntry 1007 entries / 0 gate-skips / 0 depth-skips / 1007 BLITS ->
RunVertices gate NEVER hit + 2053 REAL GPU DRAW SUBMISSIONS. Everything executes; the pixels are
black ⇒ the DRAWN OUTPUT is black.
**ROOT CAUSE OF THE DELIVERY HALF (fixed): MAIN_THREAD_EM_ASM never delivers from the gpu_thread**
(runtime-main's proxy queue starves in steady state) — the WGPU readback's postMessage AND every
[wgpu] one-shot print were silently lost (that's why ShowImage looked dead); the page only painted
video_cb's zero-filled SW buffer at 12.6fps. FIX [sab-present]: the map callback publishes
m_pixels.data() (wasm heap == the page-visible SAB) + dims + seq to 0x026B3510/14/18; gamecube.html
polls at 16ms and putImageData's from the shared heap (canvas is main-thread in WGPU mode);
video_cb 'render' frames are suppressed once SAB frames flow. VERIFIED: [fps] ~19.5-20.2
(sab-present) painting real readback content. (PM14's "canvas non-black" worked because decode+
device were then on PROXIED-MAIN where MAIN_THREAD_EM_ASM executes in place; the move to the
gpu_thread killed delivery silently.)
**NEXT (the render half): why do 2053 submitted draws produce a black EFB?** Probe order:
(a) render-pass color-attachment identity — is the pass writing the SAME texture
GetEFBColorTexture() returns (device/thread migration may have recreated the framebuffer while
the blit reads the old texture)? publish both pointers per frame; (b) pass LoadOp/StoreOp (a
Clear-to-black on every pass or a missing Store discards the draws); (c) a forced solid-color
test draw through the same pipeline (isolates shader/pipeline output vs attachment routing);
(d) the 07-13 A/B reference: OGL dumps /tmp/gcshots-ogl vs WGPU /tmp/gcshots (then CORRUPTED-
but-visible — the full-black is a LATER regression, window = the device migration era).
TEMP diag inventory this round (strip with the campaign): present-diag cells 0x026B1B08/0C/10/14
(Present.cpp), 0x026B3500-352C (WGPUGfx/WGPUTextureCache/WGPUVertexManager/OpcodeDecoding gate
flag 0x026B3370), probe fields viSwapN/viDupN/presentN/presentGate/wgpuChain/xfbBlit/gpuDraw.

**PM27 2026-07-23 — LFD TRI-STATE LANDED: the SAFE guarded build now runs at the proven ceiling.
24.6 gc/s / IDCT 19.1x / deopt=1 (MP4 movie; guard-free experiment was 24.7 / 18.9x; pre-fix
guarded 21.5 / deopt 41-48; campaign baseline 16.1 / 33.7x). SAB clean (peFrames 922, deopt=4
converged). Conf-gated 3457/0 + 62/0 throughout.** It took THREE stacked fixes — each diagnosed by
its own counter contradiction (deopt ring / failBits / psWith==deopt):
(v5) lfd/lfdu mark their target value_unknown (MarkValueUnknown after Bind); Flush emits a RUNTIME
widened-single round-trip check (emit_convert_to_single -> emit_psq_convert_to_double -> i64
xor/eqz vs the lane local) instead of clearing.
(v6) the check must be SET-capable, verifying BOTH lanes (unstored lane loaded into its lane local
first): keep-only (old AND ok) left bits cleared after MusyX's ISR work legitimately doubled
f27-f30 — the lfd restore brought singles back but could never re-set; select(set,clear,ok0&ok1).
(v7 — the decisive one) ReloadAll(host_may_write_fprs=false) for interp fallbacks that CANNOT
touch ps[] (mfspr/mtspr TBL/DEC timer reads, mfcr/mtcrf/mtsr/mtsrin/mfsrin/tlbie via
emit_simple_fallback, integer Rc forms, lmw): the unconditional wholesale mask clear fired on EVERY
timer read (thousands/s) and zeroed the mask constantly — the tell was psWith == deopt (every
speculating block eventually entered on a just-zeroed mask) with failBits == the entire assumed
set. FP-capable fallbacks (jit_floating_point, ps Rc, generic emit_fallback, HLE hooks) keep the
clear. CUMULATIVE CAMPAIGN: 16.1 -> 24.6 gc/s (+53%) on the safe build; native = 74. REMAINING for
60fps: the block-boundary items (bdnz fresh-activation ~185+74*S ops/iter -> in-block loops or
region-resident FPR locals), volatile-reg (f0-f13) speculation (needs per-entry stability, not
worth sticky risk yet), LC arm for scalar-FP/X-form slow paths, GQR constant specialization.
TEMP diagnostics to strip when the campaign closes: simd census cells D0-DC, deopt ring @0x026B3400,
failBits @0x026B33F8, psWith/psWithout, probe simdCensus tail.

**PM26 2026-07-23 — SINGLE-VALUED SPECULATION IMPLEMENTED + YIELD PROVEN: 24.7 gc/s guard-free
(campaign record, +53% over the 16.1 baseline; IDCT 33.7x -> 18.9x), guarded version deopt-limited
— the ONE remaining blocker is lfd mask fidelity.** Landed (conf-gated 3457/0 + 62/0 throughout;
speculation inert in test builds via the g_bem_lc_base gate — validated by boot + census + probes):
shadow mask @0x026B33E0 maintained in FPRRegCache::Flush (was_single latch + [v3] value_single
tri... flag: scalar ps outputs are ForceSingle'd widened singles behind Double repr — repr-keyed
masking cleared their bits and deopted the exact IDCT loop bodies; producers re-mark via
MarkValueSingle); ReloadAll + JitWasm CachedInterpreter fallbacks clear it; prologue guard +
EmitAssumedSingleLoads (PEM-widen INVERSE emit_convert_to_single per lane — NaN/denormal-exact,
now non-static) + deopt protocol (SAB 0x026B33E4 + downcount=0 + return start_pc; JitWasm evicts +
3-strike force-double via bem_pc_force_double); [v4] assume only STABLE regs f14-f31 intersected
with the compile-time mask. DIAGNOSTICS (TEMP): deopt-pc ring @0x026B3400 (worker EM_ASM
console.log does NOT relay — SAB ring instead), failing-bits @0x026B33F8, psWith/psWithout emission
split, probe simdCensus tail. FORENSICS: deopt ring = ALL IDCT loop-body pcs; failBits=0x78000000
(f27-f30, the lfs constants) — the audio ISR's __OSLoadFPUContext lfd-restores rewrite them as
Double ~1.6K/s, clearing their bits mid-decode; the round-tripped VALUES are still singles, the
mask just can't know. CONTROLLED EXPERIMENT (BEM_SSPEC_NOGUARD=1, one run, REVERTED to 0): guard
skipped -> deopt=0, 24.7 gc/s, peFrames 3043, IDCT 18.9x — SIMD yield proven; the guard/deopt
churn is the only gap between shipped (21.5) and proven (24.7). NEXT (exact step): lfd/lfdx mark
their target kUnknown (tri-state in PregState); Flush emits a RUNTIME widened-single check for
kUnknown regs (per stored lane: emit_convert_to_single -> emit_psq_convert_to_double -> i64
compare vs lane; both-lanes-dirty only, partial -> clear) so the context-restore round-trip keeps
the constants' bits SET and the guarded build reaches the proven 24.7+. After that: the boundary
items (bdnz in-block loops / FPR residency) attack the remaining ~19x.

**PM25 2026-07-23 — SIMD-PATH CENSUS: 96% of FMA emissions are SCALAR; single-valued speculation
is THE next fix (full design below).** Emit-time census (TEMP, zero runtime cost — jit_paired.cpp
bem_emit_census, SAB D0/D4/D8/DC, probe field simdCensus, gated on g_bem_lc_base): MP4 movie 60s =
**arith 314 SIMD / 630 scalar; FMA 9 SIMD / 204 scalar.** Confirms the deep-read: block-entry FPRs
always re-enter as Double (OnBlockEntry repr reset, fpr_reg_cache.cpp:43), so the lfs-loaded IDCT
constants poison every butterfly off the SIMD path. Also landed this round, both conf-gated 3457/0
+ 62/0: (a) FPRF/liveness narrowing (ppc_analyst.cpp: the C1 full reset now fires only at real
may-exit ops — terminators, load/stores, FL_PROGRAMEXCEPTION, and the block's FIRST FL_USE_FPU op
(MSR.FP gate); pure-FP arith no longer resets — measured NEUTRAL now, compounds once ops go SIMD);
(b) [fma-single-fast] runtime shortcut in emit_single_fma_lane (jit_fp_helpers.h): f32-round-trip
guard on all 3 inputs -> f64.mul+f64.add (exact product ⇒ == fused; Force25Bit no-op on <=24-bit
mantissas) + lean non-NaN ForceSingle; NaN results/inputs fall to the full pipeline (FPSCR/ladder
byte-identical); ~70 ops vs ~600-900 — measured 22.1 gc/s vs 21.1/21.3 (direction right, within
drift band; kept).
**SINGLE-VALUED SPECULATION DESIGN (verified against the code; step 1 DONE, protocol details
worked out below):**
1. DONE (conf-gated 3457/0 + 62/0, MP4 gc 2415 boot intact): lfs/lfsu/lfsx emit Single repr —
   emit_fastmem_lfs_body_single (raw f32 bits -> v128 splat, NO widen; flush's EmitPromoteToDouble
   PEM-splice keeps ps[] bit-identical) + per-lfs frc.Flush dropped (flush-narrow precedent).
   Census unchanged as expected (constants consumed in LOOP blocks — needs steps 2-3).
   PROTOCOL DETAILS for steps 2-3 (worked out this round — use these, they resolve the sharp
   edges): (a) mask RMW in FPRRegCache::Flush: latch was_single BEFORE EmitPromoteToDouble
   (promote flips repr to Double and dirties lanes — a naive post-store check would clear the
   bit just set); ReloadAll emits mask=0 (host mutated ps[]); any C++-side interpreter execution
   of FP ops in JitWasm::Run must clear the mask too. (b) prologue reload of an assumed FPR must
   NOT use f32.demote_f64 (spec-canonicalizes NaN payloads) — use the bit-level INVERSE of the
   PEM widen: single_bits = ((hi32 & 0xC0000000) | ((x >> 29) & 0x3FFFFFFF)) — exact for every
   widened single incl. NaN payloads, ~7 ops/lane, no FP ops. (c) deopt = store {pc} to a SAB
   deopt cell + ctx DOWNCOUNT=0 + return start_pc: downcount=0 makes bem_chain_loop_c break after
   this block (count>0 && dc<=0 bail), returning to JitWasm::Run, which checks the cell ->
   sticky force-double set + EvictBlock(pc) -> next dispatch recompiles without the assumption
   (converges; one early slice end per deopt, once per pc). (d) force-double set lives C-side in
   block_cache.cpp with an accessor the emitter queries at emit time (avoid signature churn).
   (e) assumed set = block.m_fpr_inputs (blocks whose live-ins are genuinely double — lfd
   restores etc. — deopt once and stay double).
2. Shadow mask: one u32 SAB cell (e.g. 0x026B33E0), bit i = "ps[i] memory is f32-valued in both
   lanes". Maintained at FPRRegCache flush: Single-repr flush (EmitPromoteToDouble path,
   fpr_reg_cache.cpp:182-190) sets bit i; Double-repr dirty-lane flush clears it; ReloadAll +
   JitWasm Run() entry clear ALL bits (host may have mutated ps[]).
3. Block compile: assumed_mask = live-in FPRs read by the block's ps ops (union of fregsIn over
   OpType ps). Prologue emits: load cell; and assumed; eq assumed; on MISMATCH -> deopt (set a SAB
   flag + store pc=start + return); host TryCompileBlock sees the flag -> sticky per-pc
   force-double blacklist -> recompile without the assumption (converges, no deopt loop). On MATCH:
   load i64 pairs + demote to v128 (12 ops/FPR, lossless — mask guarantees f32-valued) + repr=
   Single -> the jit_paired IsSingle gates (jit_paired.cpp:371,446) fire for the whole block.
4. Verification: census D8/DC must flip to ~SIMD-dominant; then FPRF-narrowing (a) multiplies.
Remaining also-rans: extend LC arm to scalar-FP/X-form/FLOAT-psq slow paths (SAB audio 6.6M
calls/60s); in-block loops / region-resident FPRs for the bdnz boundary (~185+74*S ops/iter).

**PM24 2026-07-23 — LOCKED-L1 WINDOW LANDED: LC host calls 222.7M -> 0 (MP4), gc-rate best-ever.**
The all-width slowmem audit (read8/16 + write8/16 now audited too, LC split to its own bucket
@0x026B33BC — probe field slowmem=RAM/MMIO/GP/LC) exposed what the 32-bit-only audit hid:
**222.7M locked-L1 (0xE0000000) host calls per 120s MP4 movie probe** — THP's pixel workspace
(__THPLCWork640, per decomp THPDec.c) hit via quantized psq_st/psq_l, each a cross-instance import
+ full-MMU fallback. FIX (conf-gated test_diff_next 3457/0 + test_gekko_next 62/0; MP4 gc 2327
best-ever, SAB peFrames 923 no regression): (1) `g_bem_lc_base` (= Memory::GetL1Cache(), published
by JitWasm.cpp at compile-input setup) + LoadStoreParams.lc_base; (2) emit_slowmem_load_value/
emit_slowmem_store grew an LC arm — [0xE0000000,0xE0040000) served by raw in-wasm load/store at
lc_base + (EA & 0x3FFFF), guest-BE, MMU.cpp:246-253 parity; the region test lives INSIDE the
already-slow else arm so RAM fast hits pay zero; (3) all 8 quantized psq slow arms re-pointed at
those helpers; (4) stateless_read_w/write_w LC shortcut ABOVE the worker_owns_cpu gate (the LC
memcpy is ownership-independent) for residual imports. MEASURED (aligned movie window): 21.3 gc/s
vs 16.1/17.9/15.3/15.4 across ALL prior same-day states (exceeds both ambient regimes); IDCT ratio
23.5x (from 33.7 baseline). LC bucket (drift-immune): MP4 222.7M -> 0. FOLLOW-UP: SAB still shows
6.6M LC-bucket calls/60s (audio engine LC via scalar-FP lfs/stfs + X-form + FLOAT-psq slow arms
that don't use the shared helpers) — now cheap via the stateless shortcut, but extend the in-wasm
LC arm to those sites next. Remaining IDCT gap (~23x) = in-block items per PM23 round-2 list
(FPRF ~85 ops/ps-op, bdnz fresh-activation, mixed Single/Double scalar fall-off).

**Principle (user directive 2026-07-22): the gap is ACCURACY to local native dolphin dual-core, not
throughput. Make the seam identical to native and DELETE whatever compensated for the difference.**
Native model (ORACLES.md, confirmed live): CPU thread = JIT + CoreTiming + ALL devices + interrupt
delivery, in-process; GPU thread = RunGpuLoop + render; ONE boundary = the GX FIFO.
Every item below was verified in-tree 2026-07-22 (this session); re-verify line refs before editing.

## A. Structural deviations (make identical to native)

1. **RunGpuLoop never runs.** gpu_thread is neutered (Core.cpp `#if defined(__EMSCRIPTEN__)` hunk in
   FifoPlayerThread-adjacent EmuThread code; motivated by the unexplained "gpu_thread reads
   distance=0 / memory-isolated" observation). Decode instead = retro_run (proxy-main) →
   `Fifo.h DrainFifoOnCpuThread` → `RunGpuOnCpu` — the SINGLE-CORE path. Native-exact target: the
   device-owning thread runs RunGpuLoop's dual-core chunk body (SafeCPReadPointer publication,
   per-chunk `AsyncRequests::PullEvents` (Fifo.cpp:423), gpu_mainloop semantics) — either by fixing
   the gpu_thread memory-isolation anomaly (root-cause it: a pthread MUST share memory; if the spawn
   path instantiates a fresh Memory that is a build/link bug) or by making proxy-main the GPU thread
   properly. The `[dc cp-gate]` mutex (MMIO.h/MMIO.cpp/Fifo.cpp) and `[dc safe-rp]` fix exist ONLY
   because RunGpuOnCpu is the decoder; delete both when decode is RunGpuLoop-exact.
2. **AsyncRequests drain cadence.** Native drains per chunk inside RunGpuLoop; ours drains once per
   retro_run AFTER the decode batch (Main.cpp "[present GATE B]") — ordering deviation (e.g., a
   queued ResetVideoBuffer from PI_FIFO_RESET applies after the batch that needed it).
3. **Dead-but-present takeover machinery** (native has NO takeover). The ppc-worker still spawns,
   handshakes, and polls forever ("boot-dispatch: anchor not reached (poll stays alive)" every run).
   Strip list: worker spawn (or gate behind an explicit flag), PixelEngine.cpp SetFinish arm block
   (armframe @0x026B0A30 / ho_arm @0x026B0980), JitWasm.cpp ho_arm clamp/park block (~L295-345),
   gamecube.html cpu_owner/armframe plumbing + handover gates, EmscriptenWorker owner-edge/one-clock
   blocks, `gpfifo_redirect_excursion_to_ring` + `g_gp_discard` + `g_in_drain` (GPFifo.cpp),
   `dolphin_sync_worker_fifo` + worker-fifo pub block (EmscriptenWorker.cpp), the GP ring
   (0x026C0000) and ppc_worker.js wgp-order/mi-regfile/perf-zero/pi-mask/mmio-mirror shadows — all
   takeover-era. Verify each is dead on the live path first (their own counters exist: wfArmed=0,
   gpRing head/tail=0, wgpGateN=0 across all 2026-07-22 runs).
4. **UpdateGatherPipe wp-invariant pre-sync + [dl-fifo fix] same_buffer gate** (GPFifo.cpp:100-141)
   — cross-worker-era resync; native has no equivalent. Review for deletion once (1) lands (the
   divergence source was the retired worker paths).
5. **Fifo tick heuristics** — SyncGPUCallback m_sync_ticks reset, SyncGPUForRegisterAccess
   force-drain (both `#ifdef __EMSCRIPTEN__`, Fifo.cpp), DrainFifoOnCpuThread's artificial
   m_sync_ticks seed (Fifo.h:75) — single-core-era; delete with (1).

## B. Diagnostic bloat (strip mechanically — grep the tags)

`grep -rn "dc-diag\|domino3\|TEMP]" gamecube/dolphin-src/Source/Core gamecube/dolphin-bridge` —
GPFifo.cpp (entry counters, live CP publish, &fifo publishes, wtgt dump), Fifo.cpp (rgoc/rgl
counters), CommandProcessor.cpp counters, DVDInterface.cpp DI counters, BPStructs.cpp SETIMAGE3,
OpcodeDecoding.cpp CALL_DL census + garbage-draw trap, JitWasm/EmscriptenWorker domino3 leftovers.
DONE 2026-07-22: cmd-ring, unkop byte-dump, out-of-sync assert enrichment (stripped same day, after
they caught the gather-pipe byte deletion).

## C. Keep (native-matching, or required until A1 lands)

- `[dc safe-rp fix]` RunGpuOnCpu SafeCPReadPointer publication — native RunGpuLoop behavior.
- `[dc cp-gate]` MMIO-write-vs-decode-chunk mutex — compensation, delete with A1.
- `[restructure gather-ownership]` proxy-main gather-drain gated to takeover mode — REMOVES a
  non-native call (the gather pipe is CPU-thread-private in native).
- `[park-trap disarm]` gamecube.html armframe default 0 — no takeover ⇒ never arm.

## STATUS 2026-07-22 PM — dual-core UNCONDITIONAL (user directive: "no flags, it is the only way")

gamecube.html always writes SAB 0x026B0AF0=1; Core.cpp gpu_thread ALWAYS runs RunGpuLoop;
Main.cpp's proxy-main DrainFifoOnCpuThread call is DELETED. There is ONE decode path: RunGpuLoop
on the gpu_thread, as native.

**GPU LOOP FIXED 2026-07-22 PM3 — the murder weapon was Core.cpp:1039:** under __LIBRETRO__ the
per-frame callback called `StopGpuLoop()` in dual-core (the native-libretro run-once-per-retro_run
idiom, paired with the Main.cpp #else branch we don't use) — it killed the persistent gpu_thread
loop ~300ms into EVERY boot (3 sleeps then m_shutdown; heartbeat 0x026B1BE4/1BE8 + dcInitDual
@0x026B1BE0 proved the path). Now gated `!defined(__EMSCRIPTEN__)`. VERIFIED LIVE: rglDrain=59,
cpDistGpuMax=32 (no backlog), sleepPre==sleepPost=49, nonceGpuSeen=1207 (live cross-thread reads).
Prepare() also made unconditional at Fifo::Init (dcInitDual=1 — order theory was moot).

**STORM RAISER FIXED 2026-07-22 PM6 — the throttler was disabled:** DolphinLibretro/Boot.cpp:541
`Core::SetIsThrottlerTempDisabled(true)` (libretro "frontend paces" idiom) ORs into
IsSpeedUnlimited (CoreTiming.cpp:577) — nothing paces the freed EmuThread, so emulated time raced
at wasm-max. FIX: emscripten keeps the throttler ENABLED (+ EMULATION_SPEED defaults 1.0 in
Boot.cpp/Options.cpp — note environment_cb returns false for GET_VARIABLE so call-site defs rule).
MEASURED: DSP interrupts 149,590 -> 19,638 per 90s (7.6x), audio 750K -> 122K samples/s (23x ->
3.8x native). Residual 3.8x = follow-up (VI-field Throttle cadence / max_fallback relaxation).

**PM23 2026-07-23 — ROUND 1 LANDED: psq flush-narrow + quantized-psq fastmem. PROVEN (mechanical
counter, replicated x3): slow RAM-mirror host calls 67.4M -> ~9-10M per 120s (6.6x).** Wall-speed
delta NOT reliably measured — see the drift warning below. Changes (conf-gated: test_diff_next
3457/0 failed, test_gekko_next 62/0 incl. quantized psq vectors; MP4 boot+movie intact, SAB
peFrames 894 no regression): (1) emit_psq_l frc.Flush DELETED (jit_load_store.cpp ~1230, precedent
= psq_st/integer flush-narrow — host READ never reads ps[]); (2) quantized psq_l S16/U8 arms
fastmem-guarded (was unconditional import — the 67.4M source); (3) quantized psq_st arms
fastmem-guarded (LC/MMIO/WGPIPE still reject to import, gp_dirty_check preserved); note emit_bswap
clobbers LOCAL_TMP_VAL so the GQR is RE-LOADED after fast-arm loads; (4) [bcl-pc0 TEMP] stripped
from bem_chain_loop_c.
**MEASUREMENT DRIFT WARNING (gate #8, discovered PM23): probe gc-rate drifts ACROSS RUNS more than
the deltas under test.** Same round-1 code measured 17.9 gc/s at ~08:50 and 15.4 at ~09:15 (movie
window); a spill-experiment build measured 15.3 in between (= parity with 15.4, initially misread
as a regression). Cross-run gc-rate deltas <~20% are NOT attributable to code changes. Protocol
for future rounds: (a) judge by drift-immune signals first (slowmem counters, in-run A/B toggles,
per-run function SHARE at MATCHED gc windows — align segments by gc value, not wall time); (b) for
wall-speed claims run back-to-back interleaved A/B pairs on the same machine state. ALSO
experiment result: bcx taken-arm-only keep-dirty spill (EmitSpillAll) = parity within noise, extra
complexity + per-taken-exit full-dirty-spill cost — REVERTED (clean-marking Flush amortizes across
later branches; the Single-chain fix for branchy blocks is structural, not flush placement). **ROUND 2 (the remaining 29.5x
is IN-BLOCK, ranked by the 5-agent deep-read wc5pao94i):** (a) emit_bcx flushes rc+frc before EVERY
conditional branch (jit_branch.cpp:111-112) incl. non-terminal fall-throughs — needs taken-arm-only
spill via keep-dirty cache APIs (compile-time cache state must stay valid on both arms — spill
WITHOUT clean-marking); the IDCT column pass is a 4-way in-loop branch so Singles die per branch;
(b) FPRF classifier ~85 ops/ps-op even on SIMD path (ppc_analyst.cpp:553-558 liveness reset fires
for every FL_USE_FPU op — narrow to real mid-block exits); (c) bdnz = fresh activation per
iteration (~185+74*S ops overhead; in-block wasm loop for backward self-branches, or region-
resident locals); (d) mixed Single/Double ps inputs fall scalar (~200-900-op software-FMA path) —
the lfs-loaded IDCT constants re-enter every block as Double; needs single-valued speculation
(shadow bitmask + per-block guard, constant-GQR-style) — this is why round 1 only moved the ratio
4 points; (e) locked-L1 0xE0000000 backing window + classifier admit (pixel psq_st stores,
INVISIBLE to the audit — write16 has no counter); (f) GQR constant speculation (runtime 3-level
branch tree per psq today). Instruments: PROBE_PC_SAMPLE=1 twin histograms + symbolize_hist.py
(scratchpad); baseline hists preserved at /tmp/wasm_pc_hist.baseline.json + /tmp/native_pc_hist.txt.

**PM22 2026-07-23 — HOT-BLOCK CAMPAIGN: THE 60FPS LEVER IS ONE FUNCTION.** Twin PC samplers landed:
native oracle Core.cpp sampler broadened (continuous 3s→63s, 10s segments, gc min/max per segment
→ /tmp/native_pc_hist.txt) + probe-side twin (PROBE_PC_SAMPLE=1, page-side setInterval reading
ppc_state.pc via ctx ptr @0x0250002C, 256B buckets, 10s segments + gc → /tmp/wasm_pc_hist.json;
zero-rebuild instrument — terminators store PC per block, jit_branch.cpp:93+). Scene-aligned by
gc-rate (native 74.1 gc/s vs ours 16.1), per-function cost ratio (share/gc-rate):
**__THPDecompressiMCURowNxN (0x800DEB20, THP IDCT, 1191 paired ops) = 33.7x native, 80.3% of our
guest time.** Siblings run at the norm: HuffDecodeDCTCompY 4.1x, HandleReverb 4.7x, THPAudioDecode
3.8x. Native: SelectThread idle 70%, IDCT 11%. Dropping the IDCT fn to the 4x norm frees ~70% of
EmuThread ≈ 3.3x overall — the bulk of the 4.6x gap. Fn facts: calls LCQueueWait(3) at entry
(locked-L1 0xE0000000 candidate for psq targets), 30 bdnz loops, 0x400-periodic unrolled macro,
uniform slowness across all 27 of its 256B buckets (per-op/per-block cost, not one bad range).
Slowmem audit this run: RAM-mirror 67.4M / MMIO 267K / GP 1.0M per 120s (movie window; class
counters reverted, source op family unknown). Symbolizer: scratchpad symbolize_hist.py (containing-
symbol lookup vs GMPE01_01 symbols.txt). NEXT: emit-quality decomposition of psq_l/psq_st + FPR
cache + block/dispatch for this fn vs Jit64 parity bar; fixes conf-gated via test_diff_next.

**PM21 2026-07-22 — CORRECTION: the 24M RAM calls are CHEAP (~3%), NOT the lever. Count ≠ cost.**
Class attribution (runtime slow-arm counters by op family): emitted-block integer slow = 243,806,
scalar-FP = 0, so 22.8M of the 23M RAM read32/write32 do NOT come from the JIT emitter's slow
arms at all — they enter dolphin_read32/write32 via the MAILBOX SERVICE path (EmscriptenWorker.cpp
:687-691 + worker_funcs.js:599-603, the ppc-worker/page MMIO consumer). The integer fastmem guard
WORKS (243K slow out of millions). Cross-check with the PM16 CPU profile: MMU::WriteToHardware +
dolphin_read/write self-time is only ~3% — so 380K cheap fast-RAM calls/s = a ~2-3% item, not the
~8% I mis-scoped in PM20, and nowhere near the lever. I chased CALL COUNT, not CPU COST (gate #8
lesson: a big count is not a big cost — always cross-ref the profile). REVERTED the class-audit
bumps; slowmem_audit RAM/MMIO/GP buckets left (cheap, 1 add). SECONDARY item (revisit later): the
mailbox RAM path servicing 22.8M reads — if the ppc-worker/page consumer is reading RAM through the
blocking mailbox instead of the shared SAB directly, that's pure waste, but bounded at ~3%.
**THE REAL 60FPS LEVER (unchanged, now confirmed by elimination): the 48% in emitted guest code
(wasm-function[13]).** Next = hot-block emit QUALITY: guest block profiler hot-list (working tool
per memory) + native PC sampler diff -> attack the top blocks' emitted-op count vs native, conf-
gated via test_diff_next. The dashboard (perf-split + slowmem buckets) scores it.

**PM20 2026-07-22 — SLOWMEM AUDIT = the lever, quantified.** Host-trampoline call census by
address class (dolphin_read32+write32 @0x026B33B0/B4/B8, 60s board scene): **RAM-mirror
(fastmem-ELIGIBLE) = 24,026,161; MMIO = 140,318; GP = 407,850.** 99.4% of slow cross-instance
calls are RAM addresses that SHOULD be inline wasm loads/stores — this IS the PM19 ~8% boundary
cost, and it's a classifier/coverage problem, not an inherent one. D-form scalar FP (lfs/lfd/stfd)
ARE fastmem-guarded (jit_load_store emit_fastmem_lfs/lfd/stfd_body); the leak is X-FORM indexed FP
(lfsx/stfsx/stfiwx — jit_load_store.cpp:664 "route through WIMPORT_READ32/WRITE32 without fastmem,
FPRs in MMIO range exceedingly rare" — FALSE for a 3D scene: indexed vertex/matrix loads are hot)
and/or integer accesses the runtime guard rejects. NEXT: per-op-class emit counter (tag each
op_call(WIMPORT_READ32/WRITE32) site with a static class id -> SAB bucket) to name the exact
offender in ONE run, then fastmem-arm it (emit_fastmem_guard is the drop-in — same pattern the
D-forms use; conformance-gate via test_diff_next). This is a genuine JIT throughput win toward 60fps
(24M boundary crossings/60s eliminated). SLOWMEM-AUDIT instruments live @0x026B33B0-B8.

**PM19 2026-07-22 — clean A/B: funcref-table change is a NO-OP; REVERTED. Boundary root
RE-FRAMED.** Controlled A/B (SAB 0x026B33A8 forceimport toggle, STEADY-STATE profile: 40s delay
past compile quiescence, 60s run): JS-boundary **9.36% (table) vs 9.41% (import) — identical**;
the 'set' 9% frame collapsed to 0.06% steady-state, PROVING it was boot compile churn (PM18's
delta was noise, gate #8 vindicated). ROOT (steady-state caller attribution, arm B): ~8.2% is
wasm-to-js/wrapper/js-to-wasm UNDER wasm-function[13] = the emitted guest blocks calling host
helpers. Routing via call_indirect DID NOT help because each emitted block is a SEPARATE
WebAssembly.Instance from the module exporting the helpers — EVERY block->helper call crosses an
instance boundary V8 wraps, whether import OR shared-table call_indirect. So the boundary is not
reroutable; the only levers are FEWER cross-instance calls: (1) SLOWMEM AUDIT — every slowmem
read/write calls out; fastmem stays in-wasm. MMU::WriteToHardware ~3% self + the wrapper cost =
what falls to slowmem in the board scene. Find WHY (fastmem classifier misses? MMIO-heavy scene?)
and widen fastmem coverage. (2) BIGGER MODULES — region merging already exists (block_cache
region path); more guest code per instance = fewer boundary crossings AND fewer dispatch hops
(bem_chain_loop_c ~12%). REVERTED: wimport_call.h (deleted), 41 emit sites restored to op_call,
block_cache installer + import-raw diag + gamecube.html forceimport removed. Boot verified intact
post-revert (aram/peFrames climbing, gc 710, zero popups). Campaign now: slowmem audit FIRST.

**PM18 2026-07-22 — funcref-table helper calls LANDED (campaign item 1); win UNCONFIRMED, needs
clean A/B.** Implemented: wimport_call.h emit_call_wimport() routes the 41 op_call(WIMPORT_*)
sites (7 TUs) through same-table call_indirect when g_bem_wimport_slot_base!=0; block_cache.cpp
installs the 13 raw-export helpers into consecutive shared-table slots (bem_install_wimport_helpers,
idempotent, called at FIRST EMIT so the hottest boot blocks get it + a compile_raw lazy publish).
Conformance-neutral (same fn, same args, call vs call_indirect). Boot INTACT across builds
(aram/peFrames climbing, omcurovl=1, zero popups). MEASUREMENT (PROBE_CPU_PROFILE, worker_2):
JS-boundary 9.5%(PM16) -> 6.79% -> 6.49%, emitted wasm-function[13] 43.7% -> 38.6% — DIRECTION
right, but a new 'set' 9% frame + wasm-function[13] variance + this run reaching only gc=536 (vs
~700) = heavy in-window COMPILE CHURN confounding single-run deltas (gate #8: don't claim a win
from noisy runs). TODO: clean A/B = warm-cache / post-compile-quiescent window, or a per-emit
call_indirect-vs-import counter, to isolate the real delta. Keep the change (correct + low-risk);
NOT verified as the headline win yet. Next regardless: dispatch (bem_chain_loop_c ~12% — the
stable #2) + slowmem audit (MMU::WriteToHardware ~3%, still fastmem-missing in the board scene).

**PM17 2026-07-22 — JS-boundary root VERIFIED + fix design (campaign item 1):** import-raw diag
(@0x026B33A0, rev2 `[native code]` stringify test — rev1's `instanceof WebAssembly.Function` is
the unshipped type-reflection proposal, ALWAYS false in stable Chrome, invalid) reports **1/6750:
the emitted blocks' env bindings ARE raw wasm exports** (assignWasmExports attaches
Module._dolphin_* = wasmExports.* directly, ASSERTIONS=0). The ~5.5% wasm-to-js/wrapper/js-to-wasm
under wasm-function[13] is therefore V8's CROSS-INSTANCE IMPORT CALL PATH itself (generic import
wrappers even for raw wasm targets). FIX (engine-native, in our control): route the hot helpers
(WIMPORT_READ8/16/32, WRITE8/16/32 — jit_load_store.cpp:41-46) through the SHARED
__indirect_function_table via call_indirect: (a) block_cache.cpp first-compile init reserves ~16
slots THROUGH THE EXISTING sequential block-slot allocator (avoid collision), wasmTable.set(base+k,
raw export), returns base into a C++ global (extern u32 g_bem_helper_table_base) via EM_ASM_INT;
(b) jit_load_store slow arms emit `i32.const(base+K); call_indirect(type_idx)` when base!=0, else
the current op_call import (test/fallback path); type indices already exist in the module's type
section (the imports declare them). Same functions, same args — conformance-safe mechanism swap;
verify with test_diff_next + the PM16 profile re-run (expect the 5.5% to collapse; also re-check
the 0.4% under bem_chain_loop_c). Epilogue imports (check_exc/gather_drain) = phase 2 of the same
pattern if the profile still shows them.

**PM16 2026-07-22 — EMUTHREAD CPU PROFILE (CDP, worker_2, 180K samples; PROBE_CPU_PROFILE=1):**
47.96% wasm-function[13] (the emitted guest-code module — unnamed runtime wasm), 11.50%
bem_chain_loop_c (dispatch), ~13% sleeps (futex+timedwait — throttle etc., correct), ~9.5% JS
boundary (wasm-to-js 3.18 + wrapper 1.95 + js-to-wasm ~1.3 + readEmAsmArgs/Module/Instance/
growMemViews ~2.9 — the emitted module's imports cross through JS trampolines), ~7.5% slowmem/
MMIO (MMU::WriteToHardware 3.58 + Read/Write templates + Memcheck 0.63 + dolphin_write16 1.0 +
dolphin_read32 0.39 + stateless_write_w 0.32), 1.60% emit_block_body_into (MID-RUN RECOMPILES —
check invalidation churn), 1.67% _emscripten_get_now (perf instruments — strip when done).
CAMPAIGN ORDER (impact x tractability): (1) funcref DIRECT LINKING of the emitted module's
imports (kills the ~9.5% JS boundary; the N64 M1 funcref bridge is the proven in-repo pattern —
n64/docs/jit); (2) dispatch (bem_chain_loop_c 11.5% — region promotion/chaining); (3) slowmem
audit (what falls to slowmem in the board scene? dolphin_write16=WPAR 16-bit? Memcheck gate);
(4) hot-block emit quality (the 48% — needs the guest block profiler hot-list + native sampler
diff); (5) recompile churn check. SIDE FINDING: worker_8 = libusb GC-adapter scanner BUSY-SPINS
a full core (libusb_handle_events_timeout_completed 100%) — kill/gate the adapter scan thread.

**PM15c — EmuThread split MEASURED (Advance bucket @0x026B3390/94 added to the dashboard):**
over ~90s: CoreTiming::Advance = 6.7s (~7.5%, 1.21M calls @ ~5.5us avg — devices/events are NOT
the lever), throttle-sleep 4.4s (~4.8%), device thread 2.1s (~2.3%) ⇒ **~87% of the EmuThread is
emitted-block execution + dispatch + import calls — the JIT engine is the whole 60fps campaign.**
Next decomposition: run the JIT block profiler (working tool per memory) for the guest hot-block
list; compare against the native PC sampler's list; attack the top blocks' emit quality
(conformance-gated via test_diff_next per change). Watch dispatch overhead + per-WGP-store import
cost (gpfWrite32 path fires per gather word during rendering) as candidate cross-cutting wins.

**PM15b — JIT campaign entry point (grounded):** powerpc-next ALREADY fastmem-guards psq loads/
stores (jit_load_store.cpp ~1255+: emit_fastmem_guard in the FLOAT paths; the "stfd/psq slowmem-
only" note was the OLD gekko-era bridge comment) and the psq conversions are bit-exact. So the
4.6x is NOT one missing fast path — profile FIRST: EmuThread self-time breakdown (dispatch loop
vs emitted-block execution vs import round-trips vs CoreTiming/device service). Tools: the JIT
block profiler (working per memory), the perf-split dashboard (0x026B3380/84/88), and the native
PC sampler for guest-function comparison. Per-change conformance via test_diff_next
(gamecube/tools/conformance/run.mjs).

**PM15 2026-07-22 — 60FPS LIMITER MEASURED: the guest JIT (EmuThread).** perf-split instruments
(slice self-time @0x026B3380/84, CPU throttle-sleep @0x026B3388 — kept as the perf dashboard):
over 90s, device thread = 2.1s busy (~2.4% util, 0.09ms/slice x 23K slices); CPU thread slept
only 4.75s (~95% busy) at ~21% native speed (13/60fps). Render side idles; JIT needs ~4.6x.
Independently reconfirms [[native-pc-sampler-and-decode-bottleneck-2026-07-12]] (native 80% idle
vs our ~5%; paired LOAD/STORE-bound). NEXT CAMPAIGN = bementalJIT emitter throughput: paired
load/store (psq_st/psq_l, stfd/lfd) fastmem coverage + emit quality, real downcount, then
re-measure on this dashboard. Route-A parallel GPU worker NOT needed for 60fps (GPU side at 2%).

**PM14 2026-07-22 — DEVICE-MIGRATION PHASE 1 LANDED: GEOMETRY RENDERS.** RunGpuLoop's payload
extracted as FifoManager::RunGpuLoopSlice() (Fifo.h/.cpp — native per-chunk protocol verbatim);
retro_run (proxied-main = the WebGPU device thread, whose pump yields the event loop the async
device init needed) runs the slice per pump (Main.cpp; GATE B retired — the slice pulls events);
the spawned gpu_thread PARKS (Core.cpp — never-Run mainloop keeps FlushGpu/ExitGpuLoop no-op).
All three decode device-gates auto-lift on the device thread. VERIFIED (MP4): drawN=1668,
drawVerts=6672, efbCopyN=832==peFrames (copy per frame), canvas 286,720/307,200 non-black,
aramReqN=1992, omcurovl=1, gc 718, 792 frames @63s (~12.5fps), zero popups. Dual-core split =
EmuThread (CPU: JIT+CoreTiming+devices) ∥ proxied-main (GPU: decode+render+present).
REMAINING: (1) PERF to 60fps on this baseline; (2) Phase 2 true parallel GPU worker (route A)
when perf demands it; (3) WGPUTextureCache CopyEFB-to-RAM still empty (the post-menu texture
garbage item) + depth-copy skip; (4) 240pSuite bringup; (5) final TEMP-ring strip.

**PM13 2026-07-22 — CROSS-GAME VERIFIED + HOT-PATH STRIP DONE.** MP4 (gc 754+, aram 1992,
zero popups), SAB (peFrames 401+), PSO (peFrames 1097+) all run the dual-core chain; 240pSuite
= separate pre-existing bringup bug (PC 0x80009374, pre-GX, libogc — own investigation).
Stripped (regression-verified identical boot): BlockingLoop per-iteration seq stamp, Fifo
payload/drain seq + dist-diag RMW probe + nonce (both halves), CommandProcessor per-burst
publishes, DSP per-UpdateInterrupts guest-queue reads. KEPT: cheap counters the probe reads,
the worker-error capture (permanent), all fixes. REMAINING TEMP to strip when rendering lands:
stage/frozenChunk probe fields, aram/cw/ctrl rings, sleep heartbeats, loop-exit marker.
**NEXT CAMPAIGN — WGPU device migration to the gpu_thread** (lifts the 3 decode gates + GATE B +
cp-gate + safe-rp, restores geometry): the hard constraint is async requestAdapter/requestDevice
on a pthread that never returns to its worker's event loop. Two viable routes: (A) message-driven
GPU WORKER (ppc-worker pattern: JS-driven worker owning device + decode, wasm exports per
message — no blocking mainloop, event loop turns naturally); (B) init-phase yielding on the
gpu_thread (structure RunGpuLoop entry as a continuation: create device via callbacks BEFORE
entering the blocking loop, with the pthread returning to its wrapper between steps). Then perf
to 60fps on the post-migration baseline.

**PM12 2026-07-22 — BOOT UNLOCKED ON TRUE DUAL-CORE.** The RunFifo freezes were wgpu calls on the
device-less gpu_thread, found chunk-by-chunk via the seq/stage/frozenChunk rig: drain#59 = EFB-copy
trigger (BPStructs BPMEM_TRIGGER_EFB_COPY — gated), drain#79 = the FIRST DRAW (0x80 quads →
VertexLoaderManager::RunVertices → WGPU vertex manager — gated in OpcodeDecoding.cpp, size-safe
since stream advance is computed independently). WITH BOTH GATES: aramReqN=1992 (full native
upload), peFrames fires, omcurovl=1, dvdCmdN 352+, gc 772+ @90s, frames 855 @63s, zero popups.
The boot chain that was dead all day (finish token -> FinishQueue -> ARAM #11 -> overlay -> DVD)
runs end-to-end. THE THREE INTERIM GATES (VertexManager Flush, EFB-copy trigger, draw/RunVertices)
defer actual GEOMETRY to nothing — visuals are cleared/XFB-only until the WGPU DEVICE MIGRATES to
the gpu_thread (the A1 endgame; lifts all three gates + GATE B + cp-gate + safe-rp). NEXT:
(1) cross-game probes (SAB/PSO/240p), (2) device migration, (3) diagnostic strip (seq/stage/
frozenChunk/aram/ctrl/cw rings + heartbeats), (4) perf to 60fps on the clean baseline.

**PM11 2026-07-22 — PM10's wait-primitive attribution REFUTED by its own fix; the freeze is
un-timestamped and the rig needs sequencing.** The raw-futex sleep replacement (BlockingLoop.h
[dc wait fix] — engine-level memory.atomic.wait 1ms slices on m_running_state, no condvar/clock;
KEPT, harmless and more robust) changed NOTHING: identical freeze. This run's state at freeze:
rglEntry==rglElse==rglPastPull==124,701,731 (last payload COMPLETED all publishes),
sleepPre==sleepPost=75 (not sleeping), rglExited=0 (not exited), cpIntWait=0 cpAtBp=0 (drain gates
OPEN), published distance=32 — yet drain #60 never entered AND the ledger says 93 credited − 59
drained = 1088 outstanding vs the published 32 (mutually inconsistent ⇒ the publishes straddle the
freeze instant with unknown ordering; gate #8 dirty-rig). WHAT'S CERTAIN: the gpu_thread stops
executing the mainloop entirely at some instant T (all its counters freeze together), in a state
that was healthy-spinning (~2M payloads/s), with no sleep, no exit, no blocked publish. NEXT
(rig-first): add a shared monotonic seq (one Atomics cell) stamped into EVERY publish site (GPU
payload, CPU burst, sleep pre/post) so T is ORDERED against the 93 bursts and the last drain; and
publish a gpu_thread liveness tick from OUTSIDE BlockingLoop (e.g. a wrapping for(;;) heartbeat in
RunGpuLoop around m_gpu_mainloop.Run) to separate "thread died/trapped" (worker onerror invisible
to the probe's console capture — also check page 'error' events) from "loop wedged in the switch".
A TRAPPED THREAD (wasm trap in a payload call reached at T, e.g. inside OpcodeDecoder on chunk 60)
now fits best — it explains frozen-everything with open gates and no sleep/exit, and the probe
currently captures no worker-level error events. Also verify the dist-diag values' instant by seq.

**PM10 2026-07-22 — TERMINAL FINDING: the gpu_thread's BlockingLoop WAIT PRIMITIVE dies.**
dist-diag discriminator: same &CPReadWriteDistance both threads (0x12072900), GPU plain load ==
RMW fetch_add(0) read (32/32) ⇒ NO memory/staleness anomaly — the GPU loop simply stopped
ITERATING near credit #59; the CPU then credited 34 more chunks (incl. the finish token, distance
1120) into a dead loop. Loop-exit marker @0x026B331C = 0 ⇒ m_gpu_mainloop.Run NEVER RETURNED: the
thread is suspended inside BlockingLoop STATE_SLEEPING's `m_new_work_event.WaitFor(100ms)` — BOTH
the 100ms self-timeout AND ~34 RunGpu()->Wakeup() notifies fail to rouse it, after ~81 successful
sleep/return cycles (sleep heartbeat 0x026B1BE4/1BE8; ~8s wall — note 81x100ms timeout ≈ 8s).
⇒ Common::Event::WaitFor (std::condition_variable::wait_for -> emscripten futex/clock) hangs
forever on this pthread after early success. FIX CANDIDATES: (1) replace the m_gpu_mainloop idle
wait with a raw SAB-native wait (emscripten_futex_wait / Atomics.wait loop with bounded timeout) —
bypasses condvar+clock entirely; (2) instrument Common/Event WaitFor internals (deadline value,
clock_gettime on that thread pre/post) to catch a frozen/overflowed per-thread clock; (3) test
timeout=0 (plain Wait()) + verifying Set() notify delivery separately. When the loop stays alive,
the finish token decodes -> PE_FINISH -> FinishQueue wakes -> ARAM #11 -> boot proceeds; ALL
downstream blockers (PM4-PM9) funnel through this one primitive.

**PM9 2026-07-22 — THE STALL IS THE FINISH TOKEN; the contradiction is now minimal and exact:**
0x801d45f4 = FinishQueue (symbols) — the main thread sleeps in GXWaitDrawDone; peFrames=0 in EVERY
run (SetFinish never fires); everything else (ARAM #11, overlay, DVD 12, gc) is downstream of that
wait. Ledger (ungated [domino3-real] counters + CTRL ring): gpbAdv=93 gpbEarly=0 — ALL 93 bursts
LINKED and credited (+2976); ctrlRing = six GXInit-era writes ending 0x15 (linked+read-enabled), NO
DL unlink ever (PM8's "34 unlinked" pointer-math story DEAD — it compared cross-run values).
Decoder consumed ~59 chunks then its CPReadWriteDistance loads return 0 (cpDistGpuMax=32) while
~34 credited chunks (containing the finish token) remain — WITH same-address coherence PROVEN for
the fifo's first word (nonceGpuFifo0==nonceCpuFifo0=0x312c40, live). So: plain atomic loads of ONE
field (CPReadWriteDistance) on the gpu_thread read 0 while the EmuThread's fetch_add history says
~1100 — either a stale-load engine anomaly specific to RMW-vs-load pairing, a signal error in the
diag (gate #8: suspect the instrument), or a zeroing store not yet found. NEXT (one run): in the
RunGpuLoop else-branch publish side-by-side {plain load, fetch_add(0) RMW read, &distance} and on
the EmuThread publish {distance, &distance} at each burst — same-window comparison settles
stale-load vs zeroed vs wrong-object in one probe. Then fix at whichever site that names.

**PM8 2026-07-22 — NATIVE TRACE + HARD-STALL PROOF + GUEST-STATE SNAPSHOT (the frontier):**
Native oracle (build-oracle nogui dual-core, [ARAM-DMA] trace): n=1-2 __OSInitAudioSystem 32B tests
(pc 800b5e80/5ec8), n=3-9 __ARChecksize 32B tests (800c67b8..6b9c), n=10 FIRST ARQ chunk 1280B at
ARStartDMA 800c6400, n=11+ 4KB stream (gc=33). OUR 10 completions == native n=1-10 exactly; we die
at the n=10→11 handoff. 258s probe: aramReqN still 10 ⇒ HARD STALL, not crawl. Guest state AT
completion #10 (published from CompleteARAM): __AR_Callback=0x800c706c (=__ARQInterruptServiceRoutine,
correctly registered), __ARQRequestQueueLo/Hi=0 (normal for MP4's synchronous one-at-a-time posts).
⇒ THE BREAK IS INSIDE THE GUEST ISR TAIL: __ARHandler entered (its +0x2c ack executed, ring),
callback pointer valid, yet the owner-callback→thread-wake→next-ARQPostRequest never happens —
~150 plain-code instructions (__ARHandler tail, __ARQInterruptServiceRoutine 0x800C706C size 0xCC,
__ARQServiceQueueLo) executed by OUR JIT fail to produce the wake. NEXT (pick one):
(1) publish __ARQRequestPendingLo (+ Hudson's wait-flag once identified) at completion + at each
VI tick — did the pop/owner-callback happen; (2) re-enable the JIT guest-PC ring across the ISR
window to see exactly where the flow derails; (3) run the conformance harness on the
__ARQInterruptServiceRoutine/__ARQServiceQueueLo blocks vs the DolphinPPCTests oracle (the ISR tail
uses lwz/stw/mtmsr/rfi patterns — a single emitter bug here explains a silent derail).

**ARAM CHAIN FULLY MAPPED 2026-07-22 PM7 (ARAM-filtered DSP_CONTROL write ring + MP4 symbols):**
the 13 ARAM-relevant control writes resolve to: 4x __OSInitAudioSystem init clears (0x800b5e18/
5e98/5ee0/5f34), SetInterruptMask+0x100 enable (0x800b742c), **7x __ARChecksize polled acks**
(0x800c67e0..6bbc — ARInit's size-detect test DMAs, serviced by POLLING not ISR), and **exactly
ONE __ARHandler+0x2c ISR ack** (0x800c6608, val 0x970 = masks ON + ARAM write-1-clear). Ten
completions = 7 checksize + 1 ISR-serviced + 2 that fired during a mask-off window
(maskedAramN=2). The upload dies right after the single __ARHandler run; aramReqN froze at 10.
REMAINING AMBIGUITY (one instrument): the ORDER of the last 3 completions vs the __ARHandler ack —
story A: pending statuses accumulated while masked, __ARHandler's write-1-clear ATE them (its ack
clears ALL pending ARAM statuses, not just its own) -> the wake for those chunks never fires;
story B: ARQ bookkeeping corrupted earlier (checksize-era). DISCRIMINATOR: interleave-sequence ring
(one shared seq counter stamped at每 CompleteARAM and each ARAM-ack write) — if masked completions
precede the 0x970 ack, story A is proven. FIX CANDIDATES: (A) hold GenerateDSPInterrupt(INT_ARAM)
re-assert after ack when completions>acks (make the status level-track outstanding completions —
what real HW effectively does since the serial SDK chain never accumulates), or match native
timing so completions cannot land in init's mask-off window (the checksize test-DMA completion
latency (count/32)*246 vs our JIT's placeholder downcount — cycle-accounting gap, the known
[[native-pc-sampler]] item). Compare __ARChecksize/__ARHandler in ~/gc_refs/dolsdk2001/src/ar/ar.c
before choosing.

**REMAINING (the second blocker, now isolated): ARAM enable clobbered — enARAM=8 < aramComplete=10.**
Two of ten ARAM-DMA completions arrived while DSP_CONTROL's ARAM interrupt-ENABLE was clear
(UpdateInterrupts enable&active census @0x026B2720): they never entered INT_CAUSE_DSP, the guest's
__ARHandler/ARQ callback never serviced them, upload dead at 10/1992. A DSP_CONTROL write between
completions carries a stale/wrong enable image (guest RMW vs completion interleave, or write-path
semantics diverging from dolsdk ar/arq driver expectations). NEXT: ring-log the last N DSP_CONTROL
WRITE values (+pc) around completions #9/#10 to catch the clobbering write; compare semantics with
~/gc_refs/dolsdk2001/src/ar/ (AR/ARQ ack composition) and upstream dolphin's DSP_CONTROL write
handler. Instruments live: aramReqN @0x026B1BD0, aramComplete @0x026B2700 (ungated), enDSP/ARAM/AID
@0x026B271C/20/24 (ungated), mailPopN @0x026B1BB0, dspCauseSet/Clr @0x026B1BC0/1BCC, extDeliv*
@0x026B1BC4/1BC8.

**BOOT STALL RE-CHARACTERIZED 2026-07-22 PM5 — it is the DSP INTERRUPT STORM, not a lost
interrupt (superseded by PM6 above):** new ungated counters (PI INT_CAUSE_DSP sets @0x026B1BC0 / clears @0x026B1BCC in
SetInterrupt; EXT delivery commits @0x026B1BC8 / with-DSP @0x026B1BC4 at the PowerPC.cpp EXT
commit) measured dspCauseSet=147,932 / dspCauseClr=147,931 / extDelivDsp=150,869 in one stalled
run — the guest ISR services DSP ~1.6K/s CONTINUOUSLY while aramReqN stays 10 and gc=0. Delivery
is NOT broken (previous "10th int lost" attribution WRONG; the takeover delivery gates I stripped
in PowerPC.cpp CheckExternalExceptions were dead — strip kept, it's correct bloat removal).
Mechanism (matches the C5 anti-storm note in DSP.cpp Do_ARAM_DMA verbatim: "EXT alternating
OSRestoreInterrupts/aramSyncTransferQueue forever — a new DSP completion always pending before
the guest's rfi lands"): something DSP-side re-raises INT_CAUSE_DSP immediately after every ack
(unconsumed DSP-HLE mailbox state is the prime suspect — MusyX init has mail pending while the
guest is still in the ARAM upload phase and can't consume it); the guest's generic acks
(DSP_CONTROL writes) also clear the ARAM-int status, so the ARQ callback never runs → upload
frozen at 10/1992 DMAs. ALSO: [audio-diag] 743,041 samples/s vs native 32,000 (23x overspeed;
morning runs were 65,890 = 2x) — the audio/DSP cadence is unthrottled in the new topology.
NEXT INSTRUMENT: at each dspCauseSet record the RAISER (DSP_CONTROL int-status bits + HLE
mail-pending flag) and count DSP_MAIL_FROM_DSP LO reads (mail pops) — separates "mail pending,
never popped" from "ARAM/AID re-raise"; then fix at the raiser (native = the guest pops the mail
because init ORDER differs, or our HLE raises early). Also verify DSP_CONTROL write handler ack
semantics vs upstream (generic ack clearing ARAM status it shouldn't).

**BOOT STALL LOCALIZED 2026-07-22 PM4 (native DVD oracle + req/completion counters):** native log
shows reads 1-11 = filesystem/banner, then guest-side overlay start (objman "Call New Ovl 1" →
"Link DLL:dll/bootdll.rel") = read 12. Our guest stalls BEFORE the overlay call (omcurovl=
0xffffffff, never 1) inside MP4's audio/ARAM init: **aramReqN=10 == aramComplete=10** (counters
now ungated: requests @0x026B1BD0 Do_ARAM_DMA, completions @0x026B2700 CompleteARAM) — ten DMAs
requested and completed, GenerateDSPInterrupt(INT_ARAM) called ten times, guest never kicks #11
(native runs ~1992). exc=4 pending in snapshots. THE 10th completion's EXTERNAL_INT never reaches
the guest ISR: the loss is between UpdateException's `Exceptions |= EXTERNAL_INT` and guest ISR
entry (JitWasm dispatch-loop delivery — suspect the idle-spin/hot-region chain not breaking for
pending EXT, or a delivery gate). NEXT: count UpdateException EXT raises vs JitWasm
CheckExceptions-with-EXT deliveries vs guest ISR entries in one run; check guestRetrace liveness
in the SAME run (if VI delivery also dies at the same instant, it's general EXT delivery death,
not DSP-specific). Also landed: [dc device-events] gate (RunGpuLoop pulls AsyncRequests only on
the device thread — presents no longer eaten by the gpu_thread; keep).

**REMAINING boot stall (original notes):** guest parks at apploader with dvdCmdN=11 frozen, peFrames=0 —
DVD command 12 never issues, upstream of all GX (the guest never sends a finish token). Suspects:
the same frame callback's unconditional `CPU().Break()` under __LIBRETRO__ (the `if
(s_stop_frame_step)` guard is compiled out — verify), AsyncRequests events now pulled on the
gpu_thread (device-gated present dropped), or the DVD completion chain. Reproduces identically
every run. Diagnostics to strip when boot lands: sleep-heartbeat (BlockingLoop.h), nonce
(GPFifo.cpp/Fifo.cpp), dcInitDual (Fifo.cpp), + probe fields.

**RESOLVED ATTRIBUTION 2026-07-22 PM2 (nonce run):** the gpu_thread SHARES memory (final proof:
its every else-iteration republishes the CPU's counter; the LAST republish read 0 ⇒ ALL 4,507,641
GPU iterations completed BEFORE the CPU's first gather flush — every "isolation"/zero reading was
a pre-boot snapshot). RunGpuLoop then entered an unbounded, uninstrumented wait inside
BlockingLoop (waitForN=0 — never the timed WaitFor; rglEntry==rglPastPull — not stuck in
PullEvents; no "Video Loop Ended" — never exited) and 93 subsequent RunGpu()→Wakeup() calls never
woke it. PRIME SUSPECT: Fifo::Init gates `m_gpu_mainloop.Prepare()` on IsDualCoreMode() — if the
config wasn't yet dual-core at Init time, the loop ran UNPREPARED and its sleep/wake state machine
is broken exactly like this. NEXT: log IsDualCoreMode() at Fifo::Init; candidate one-line fix =
unconditional Prepare(); else instrument BlockingLoop Wakeup/wait-entry state. Native oracle: the
identical machinery works natively, so the delta is init order or emscripten event primitives.

**Original statement of the bug (superseded attribution — emu-running gate was NOT the blocker):** RunGpuLoop iterates 4,625,501 times and takes the
NOT-RUNNING branch every single time (rglElse==rglEntry) — the gpu_thread observes
`m_emu_running_state` unset — while the CPU side has work queued (cpDistLive=2976, gpfBurst=93,
gpReadEn=1, cpLinkEn=1) and probe emuRunning=1. Guest parks at the apploader (dvdCmdN=11, gc=0,
PC=0x800ba2f0). Candidates: (a) two FifoManager/System instances (publish &m_fifo AND a
write-nonce from BOTH threads in one run to settle it — layout-identical instances make address
equality meaningless); (b) something repeatedly calls EmulatorState(false)/pauses (CPU-step or
pump machinery) so the flag is truly unset at every GPU-thread read. NOTE the probe's emuRunning
field must be checked for WHERE it's published — the 2026-07-21 "distance=0 = memory isolation"
claim died exactly because cpDistGpu is only published INSIDE the never-entered drain loop
(0 = never-published, not loaded-zero). Verify every diagnostic's publish site before trusting it.

## A1 experiment result (2026-07-22, ?gputhread=1 — flag SAB 0x026B0AF0, default OFF)

MP4 probe with `PROBE_QUERY="gputhread=1"`: **fifoAddrGpu == fifoAddrCpu == 0x120728f0** — the
gpu_thread publishes through the SAME shared memory the probe reads ⇒ the "memory-isolated
gpu_thread" neuter rationale is REFUTED (a private instance's SAB writes could never be visible).
rglEntry=4,621,008 (RunGpuLoop live, busy-spinning), rglDrain=0, cpDistGpu=0 — but the GUEST stalls
at boot (gc=0, frames=0, PC=0x800ba2f0 idle spin): with DrainFifoOnCpuThread off, some boot
dependency the proxy-main drain was carrying is missing (suspects: ViSwap/present chain feeding the
page, SafeCPReadPointer/SyncGPU interplay at the apploader). NEXT: find that dependency and make
boot complete in gputhread mode; then move the WGPU device to the gpu_thread; then delete
DrainFifoOnCpuThread + cp-gate + safe-rp + the RunGpuLoop busy-spin (GpuMaySleep wiring).

## Order

1. B (mechanical, zero live-path behavior risk) — then a clean baseline probe.
2. A3 (largest bloat mass; per-piece dead-path verification via the existing counters).
3. A1+A2 (decode = RunGpuLoop-exact on the device thread) — then delete C's compensations.
4. A4+A5 cleanup.

Acceptance per step: canonical 3-step loop, MP4 + SAB probes, zero popups, frames climbing, no new
faces. Open functional items tracked alongside: MP4 post-menu texture garbage (WGPUTextureCache
CopyEFB empty / depth-copy skip — one-shot '[wgpu]' console prints identify which fires in the
corrupted scene), 240pSuite renders nothing (PC 0x80009374, libogc path).
