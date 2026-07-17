// gamecube/ppc-worker/ppc_worker.js
// JS-side dedicated PowerPC JIT worker. Loads ppc_worker_emcc.js and
// instantiates it with a SHARED WebAssembly.Memory provided by the page.
// Phase 2c lays the foundation for the dolphin_worker ↔ ppc-worker
// memory sharing — once dolphin_worker is rebuilt with
// `-sIMPORTED_MEMORY=1`, the page allocates ONE memory and gives it to
// both workers.
//
// Protocol (control plane):
//   page → worker  postMessage('mem-init', { memory })
//   worker         instantiates the wasm with that memory
//   worker → page  postMessage('ready', { version })
//   page → worker  postMessage('init', { ppcStateAddr, mem1Addr, ...})
//   worker → page  postMessage('init-ack')
//   page → worker  postMessage('dispatch', { pc })
//   worker → page  postMessage('dispatch-ack', { next })
//   page → worker  postMessage('shutdown')

(function () {
  let mod = null;
  let inited = false;
  let pendingDispatch = null;  // queued if 'dispatch' arrives before 'ready'
  let sharedMemoryRef = null;  // the WebAssembly.Memory we received via mem-init
  let mailboxBase = 0;         // remembered from 'init' so the run loop can
                               // peek reply_extra1/2 after a CompileBlock
  let mem1Base    = 0;         // SAB linear-memory addr of dolphin MEM1 (set
                               // by 'update-mem'). Required by 'synth-perf'
                               // to splat a ring of pre-emitted PowerPC
                               // instructions into the guest RAM mirror.
  let mem1Size    = 0;
  let ppcStateBase = 0x02400000; // [ppc-bridge] real &ppc_state once dolphin publishes it;
                               // until then the legacy sentinel region (default unchanged)

  // Item 6 Stage 2 — feature flag. When true, env.ppc_write{8,16,32}
  // enqueue into the pending-writes SPSC ring at SAB[0x02670000] for
  // ComplexWrite (WRITE_SE / READ_WRITE_SE) cells instead of doing a
  // synchronous postMessage round-trip. dolphin drains the ring at its
  // JitWasm yield boundary (CoreTiming-equivalent cadence). Default
  // OFF so the initial Stage 2 ship keeps mailbox semantics for
  // Complex writes — design doc §4 W1 fallback. Flip ON after
  // measurement confirms no boot regression.
  const PWR_BASE_ADDR     = 0x02670000;
  const PWR_CAPACITY      = 4096;
  const PWR_RECORDS_OFF   = 0x100;
  const PWR_OFF_HEAD      = 0x08;
  const PWR_OFF_ENQ_COUNT = 0x14;
  const PWR_OFF_DROP_COUNT= 0x18;
  // [SI-crash ROOT FIX 2026-07-02] W2 ring OFF. The fire-and-forget pending-writes ring made
  // guest STORES asynchronous (dolphin drains later) while LOADS are synchronous — a
  // store->load ordering violation on the guest's own memory. MP4: SIGetType's stmw enqueued
  // saved-r31 -> 0x8019d3e4; when the drain ran late (first-compile/DoReset window), the lmw
  // read the PRE-STORE bytes (0x00808080, PADRead's dead poll data) and SIGetTypeAsync blrl'd
  // into 0x808080 -> __OSUnhandledException. Proven by the seq-ring: eaWatchStmw fired
  // (enqueue) at gt=3822, slot still old at gt=4138, dolphin_write32 tag NEVER fired (writes
  // bypassed the sync trampoline entirely). Synchronous mailbox writes restore ordering.
  // Correct fast path later: MEM1-direct SAB stores in-wasm + ring for MMIO only.
  let useWriteRing = false;

  function installWriteEnv(env, call2) {
    if (!useWriteRing) {
      // [gp-ring STEP 3 2026-07-09] WPAR-ONLY Atomics ring (the 'ring for MMIO only' fast path
      // the W2 postmortem above prescribes). Guest RAM stores stay on the SYNC mailbox (the
      // store->load ordering that W2 violated is untouched); ONLY writes to the write-gather
      // pipe (0x0C008000 mirrors — write-only MMIO the guest never loads back) go through the
      // ring, replacing one full mailbox round-trip PER GX WORD (~374k/run measured).
      // Ordering vs other MMIO: dolphin drains ring-before-ANY-mailbox-op (EmscriptenWorker
      // dolphin_drain_gp_ring at the top of dolphin_drain_mailbox_once) and on the always-runs
      // run_iter_batch body. WATERMARK: near-full -> bounded producer Atomics.wait with
      // predicate re-check (never unbounded — the consumer can be page-blocked in HW-GL mode);
      // past the bound, fall back to the sync mailbox write (ordering-safe, counted).
      // Layout @0x026C0000: +0 head (monotonic, producer) +4 tail (monotonic, consumer)
      // +8 producer-waiting flag +0xC fallback count +0x10 applied count (consumer)
      // +0x40.. data: 8192 entries x 2 words {widthBytes, value}.
      const _gsab = sharedMemoryRef && sharedMemoryRef.buffer;
      let gpPush = null;
      if (_gsab) {
        const gi32 = new Int32Array(_gsab);
        const gu32 = new Uint32Array(_gsab);
        const GP_HEAD = 0x026C0000 >> 2, GP_TAIL = 0x026C0004 >> 2, GP_WAITF = 0x026C0008 >> 2,
              GP_FALL = 0x026C000C >> 2, GP_DATA = 0x026C0040 >> 2, GP_CAP = 8192;
        gpPush = (width, val) => {
          const h = Atomics.load(gi32, GP_HEAD) >>> 0;
          let t = Atomics.load(gi32, GP_TAIL) >>> 0;
          if (((h - t) >>> 0) >= (GP_CAP - 16)) {
            Atomics.store(gi32, GP_WAITF, 1);
            for (let s = 0; s < 400; s++) {           // bounded: 400 x 5ms max
              Atomics.wait(gi32, GP_TAIL, t | 0, 5);
              t = Atomics.load(gi32, GP_TAIL) >>> 0;
              if (((h - t) >>> 0) < (GP_CAP - 16)) break;
            }
            Atomics.store(gi32, GP_WAITF, 0);
            if (((h - t) >>> 0) >= (GP_CAP - 16)) {
              gu32[GP_FALL] = ((gu32[GP_FALL] >>> 0) + 1) >>> 0;
              return false;                            // caller falls back to sync mailbox
            }
          }
          const idx = GP_DATA + ((h & (GP_CAP - 1)) * 2);
          gu32[idx] = width; gu32[idx + 1] = val >>> 0;
          Atomics.store(gi32, GP_HEAD, (h + 1) | 0);
          return true;
        };
      }
      const _isGp = (addr) => (((addr & 0x0FFFFFFF) >>> 0) === 0x0C008000);
      // [gp-seq TEMP 2026-07-10] sequence check: every guest WPAR store issued (any route)
      // counts @0x026B1A3C; dolphin counts gather arrivals @0x026B1A40. Deficit = lost
      // stores; per-snap deltas date the losing window.
      const _gpSeq = () => { u32[0x026B1A3C >> 2] = ((u32[0x026B1A3C >> 2] >>> 0) + 1) >>> 0; };
      // [mmio-write-fastpath 2026-07-17] The oracle proved the ARAM audio-init chain runs 400/s
      // native vs ~2/s here because the guest ISR issues ~6 DSP/AR_DMA register WRITES per DMA
      // (DSP_CONTROL ack 0x500A + AR_DMA regs 0x5020-0x5037), each a blocking worker->dolphin
      // mailbox round-trip (call2 -> _mailbox_call_sync2). Route those to an async ring (like gpPush)
      // so the ISR doesn't stall: worker pushes {addr,val,width}, dolphin drains+applies them in
      // dolphin_drain_gp_ring (before any mailbox op, same ordering guarantee). Excludes the DSP
      // MAIL 0x5000-0x5006 (needs sync read-back for the HLE handshake). Ring @0x02710000: +0 head
      // +4 tail, 12-byte entries {addr,val,width} @+0x40, cap 4096. Only post-takeover.
      // [DISABLED 2026-07-17] async-ing the AR_DMA writes breaks completion scheduling: Do_ARAM_DMA
      // schedules a TIMED event at the guest's global_timer, so those writes MUST be sync (applied at
      // the exact sim-time), not batched. aramComplete dropped 87->1. Only the DSP_CONTROL ack could be
      // async (1 of 6 ISR writes) — too small. Restored sync writes. The real bottleneck is the SYNC
      // write round-trip LATENCY (gated by dolphin's service-loop / blocked-render cadence), not the count.
      const _isDspAr = (addr) => false;
      let mmioPush = null;
      if (_gsab) {
        const mi32 = new Int32Array(_gsab), mu32 = new Uint32Array(_gsab);
        const MW_HEAD = 0x02710000 >> 2, MW_TAIL = 0x02710004 >> 2, MW_DATA = 0x02710040, MW_CAP = 4096;
        mmioPush = (addr, val, width) => {
          if (Atomics.load(mi32, 0x026A0000 >> 2) !== 1) return false;   // pre-takeover -> sync mailbox
          const h = Atomics.load(mi32, MW_HEAD) >>> 0;
          const t = Atomics.load(mi32, MW_TAIL) >>> 0;
          if (((h - t) >>> 0) >= (MW_CAP - 8)) return false;             // full -> fall back to sync
          const b = (MW_DATA + (h & (MW_CAP - 1)) * 12) >> 2;
          mu32[b] = addr >>> 0; mu32[b + 1] = val >>> 0; mu32[b + 2] = width;
          Atomics.store(mi32, MW_HEAD, (h + 1) | 0);
          return true;
        };
      }
      env.ppc_write8  = (addr, val) => { if (_isGp(addr)) { _gpSeq(); if (gpPush && gpPush(1, val)) return; } if (_isDspAr(addr) && mmioPush && mmioPush(addr, val, 1)) return; call2(5, addr, val); };
      env.ppc_write16 = (addr, val) => { if (_isGp(addr)) { _gpSeq(); if (gpPush && gpPush(2, val)) return; } if (_isDspAr(addr) && mmioPush && mmioPush(addr, val, 2)) return; call2(6, addr, val); };
      env.ppc_write32 = (addr, val) => { if (_isGp(addr)) { _gpSeq(); if (gpPush && gpPush(4, val)) return; } if (_isDspAr(addr) && mmioPush && mmioPush(addr, val, 4)) return; call2(7, addr, val); };
      return;
    }
    // W2 mode: enqueue into the pending-writes ring. SPSC discipline —
    // ppc-worker is the sole producer (head++); dolphin drains (tail++).
    // No Atomics.wait; this is fire-and-forget. Slot is reused once
    // dolphin's tail advances, so overflow drops the write and bumps
    // the diag drop counter (caller falls back to mailbox).
    const sab = sharedMemoryRef && sharedMemoryRef.buffer;
    if (!sab) {
      // Cannot install ring path without SAB; fall back to mailbox.
      env.ppc_write8  = (addr, val) => call2(5, addr, val);
      env.ppc_write16 = (addr, val) => call2(6, addr, val);
      env.ppc_write32 = (addr, val) => call2(7, addr, val);
      return;
    }
    const hdr32  = new Int32Array(sab, PWR_BASE_ADDR, PWR_RECORDS_OFF >> 2);
    const recU32 = new Uint32Array(sab, PWR_BASE_ADDR + PWR_RECORDS_OFF,
                                   PWR_CAPACITY * 4);
    const recU8  = new Uint8Array(sab, PWR_BASE_ADDR + PWR_RECORDS_OFF,
                                  PWR_CAPACITY * 16);
    const enqueue = (cmd, sizeBits, addr, val) => {
      // head atomically bumped; SPSC so no CAS needed.
      const head = Atomics.add(hdr32, PWR_OFF_HEAD >> 2, 1) >>> 0;
      const slot = (head % PWR_CAPACITY) >>> 0;
      const recBase = slot * 16;
      recU8[recBase + 0] = cmd & 0xFF;
      recU8[recBase + 1] = sizeBits & 0xFF;
      // _pad u16 at recBase+2 stays 0.
      recU32[(recBase >> 2) + 1] = addr >>> 0;
      recU32[(recBase >> 2) + 2] = val >>> 0;
      recU32[(recBase >> 2) + 3] = head >>> 0;
      Atomics.add(hdr32, PWR_OFF_ENQ_COUNT >> 2, 1);
    };
    env.ppc_write8  = (addr, val) => enqueue(5,  8,  addr, val);
    env.ppc_write16 = (addr, val) => enqueue(6, 16,  addr, val);
    env.ppc_write32 = (addr, val) => enqueue(7, 32,  addr, val);
  }

  importScripts('./ppc_worker_emcc.js?v=' + Date.now());

  if (typeof ppcWorkerModule !== 'function') {
    postMessage({ cmd: 'error', error: 'ppcWorkerModule factory not found after importScripts' });
    return;
  }

  function instantiateWith(memory) {
    ppcWorkerModule({ wasmMemory: memory })
      .then((m) => {
        mod = m;
        // Phase 2e C-slice path: default OFF pending cache-warmup work.
        // EE-gate fix (ppc_worker_main.cpp) makes the path correct, but
        // ppc-worker's BlockCache starts empty under ?ppcbootdispatch=1
        // and each block compiles fresh (~85ms each), so throughput
        // regresses vs dolphin-owned dispatch until the cache warms up.
        // Enable explicitly with =1 to test the architectural cutover.
        if (mod.PPC_WORKER_USE_C_SLICE === undefined) mod.PPC_WORKER_USE_C_SLICE = 0;  // [throughput A/B 2026-07-03: C-slice+merged retire ZERO (region pipeline WIP, endless gen-relink) — stay on legacy until AoT]
        const v = mod._ppc_worker_version();
        postMessage({ cmd: 'ready', version: v });
      })
      .catch((e) => {
        postMessage({ cmd: 'error', error: 'instantiate failed: ' + (e && e.message ? e.message : String(e)) });
      });
  }

  self.onmessage = (e) => {
    const data = e.data || {};
    switch (data.cmd) {
      case 'mem-init': {
        // The page hands us a SharedArrayBuffer-backed WebAssembly.Memory.
        // Phase 2c Step 3: same memory is shared with dolphin_worker via
        // Module.wasmMemory page-side injection.
        if (!data.memory || !(data.memory instanceof WebAssembly.Memory)) {
          postMessage({ cmd: 'error', error: 'mem-init requires memory: WebAssembly.Memory' });
          return;
        }
        sharedMemoryRef = data.memory;
        instantiateWith(data.memory);
        break;
      }
      case 'init': {
        if (!mod) { postMessage({ cmd: 'init-nack', reason: 'wasm not yet ready' }); return; }
        const ppcStateAddr = (data.ppcStateAddr | 0) >>> 0;
        const mem1Addr     = (data.mem1Addr     | 0) >>> 0;
        const mem1Size     = (data.mem1Size     | 0) >>> 0;
        const mailboxAddr  = (data.mailboxAddr  | 0) >>> 0;
        mod._ppc_worker_init(ppcStateAddr, mem1Addr, mem1Size, mailboxAddr);
        ppcStateBase = ppcStateAddr;
        mailboxBase = mailboxAddr;
        // Boot-dispatcher mode wiring. By default ppc-worker is the
        // real-boot dispatcher: dispatched blocks call real env.ppc_*
        // (no Option D stubs), and HLE checks go through the JS-side
        // mailbox path until the page flips native-HLE on via
        // `set-mode` (after dolphin's snapshot publishes the table).
        // Perf-measurement paths (?ppcperf=1 / ?ppcperfsynth=1) flip
        // perfStub=true via the same set-mode message before starting
        // run-continuous.
        if (typeof mod._ppc_worker_set_perf_stub === 'function') {
          const perfStub = !!data.perfStub;
          const hleNative = !!data.hleNative;
          mod._ppc_worker_set_perf_stub(perfStub ? 1 : 0);
          mod._ppc_worker_set_hle_check_native(hleNative ? 1 : 0);
        }
        // Item 7 Phase II — initialize the SAB CT queue once on init.
        // Safe to call twice (dolphin also calls dolphin_ct_queue_init
        // from SystemTimers::Init); idempotent zero + magic publish.
        if (typeof mod._ppc_worker_ct_queue_init === 'function') {
          mod._ppc_worker_ct_queue_init();
        }
        inited = true;
        // 2f.6: auto-bootstrap mod.bemental_imports.env (host imports
        // for JIT-emitted blocks) and mod.bemental_regions (region
        // table). These were previously cascade-test-only steps; now
        // production paths (run-continuous via ?ppcperf=1) need them
        // too. Idempotent — overwrites any prior values.
        if (!mod.bemental_imports) mod.bemental_imports = { env: {} };
        const env = mod.bemental_imports.env;
        const call1 = (cmd, a) => mod._ppc_worker_mailbox_call_sync(cmd, a >>> 0) >>> 0;
        const call2 = (cmd, a, b) => { mod._ppc_worker_mailbox_call_sync2(cmd, a >>> 0, b >>> 0); };
        env.memory          = sharedMemoryRef;
        // [poll-target 2026-07-09] record the last slow-path MMIO read (addr + seq) so the
        // EE=0 poll handler can DISCRIMINATE beam polls (VI range -> smooth-step) from
        // device-completion polls (DSP/EXI/AI -> jump-to-next-event). Only MMIO routes
        // through env reads, so a fresh addr here IS the polled register.
        // [mmio-read-fastpath 2026-07-17] The oracle proved the audio-init stall is THROUGHPUT: every
        // guest ISR MMIO read is a blocking worker->dolphin mailbox round-trip (call1(4,addr)), so the
        // ARAM ARQ-chain runs ~2/s vs native ~400/s and gc freezes at 156. Read the two HOT ISR
        // registers straight from a dolphin-maintained SAB mirror (no round-trip): PI cause 0xCC003000
        // @0x026B27D0 (ProcessorInterface::UpdateException release-store), DSP_CONTROL 0xCC00500A
        // @0x026B27D4 (DSP::UpdateInterrupts). Only post-takeover (cpu_owner==1); the fixed 512MB SAB
        // never grows so this view stays valid. Atomics.load = acquire, pairs with dolphin's release.
        self.__mmr = self.__mmr || new Int32Array(sharedMemoryRef.buffer);
        env.ppc_read8       = (addr) => { self.__lastMmioRdAddr = addr >>> 0; self.__lastMmioRdSeq = (self.__lastMmioRdSeq | 0) + 1; return call1(2, addr); };
        env.ppc_read16      = (addr) => {
          const a = addr >>> 0;
          if (a === 0xCC00500A && Atomics.load(self.__mmr, 0x026A0000 >> 2) === 1) {
            Atomics.add(self.__mmr, 0x026B27DC >> 2, 1);                  // [fastpath-hit] DSP_CONTROL
            return Atomics.load(self.__mmr, 0x026B27D4 >> 2) & 0xFFFF; }  // DSP_CONTROL fast-path
          self.__lastMmioRdAddr = a; self.__lastMmioRdSeq = (self.__lastMmioRdSeq | 0) + 1; return call1(3, a); };
        env.ppc_read32      = (addr) => {
          const a = addr >>> 0;
          if (a === 0xCC003000 && Atomics.load(self.__mmr, 0x026A0000 >> 2) === 1) {
            Atomics.add(self.__mmr, 0x026B27D8 >> 2, 1);                  // [fastpath-hit] PI cause
            return Atomics.load(self.__mmr, 0x026B27D0 >> 2) >>> 0; }     // PI cause fast-path
          self.__lastMmioRdAddr = a; self.__lastMmioRdSeq = (self.__lastMmioRdSeq | 0) + 1; return call1(4, a); };
        // Item 6 Stage 2 — writes go either via mailbox (W1, default) or
        // SAB pending-writes ring (W2, gated by `useWriteRing`).
        installWriteEnv(env, call2);
        env.ppc_hle_check   = (pc) => call1(8, pc);
        env.ppc_interp      = (inst, pc) => {
          // [store-watch 2026-06-29 TEMP] BUG 2: marker 0xFFFFFFFB = a 32-bit store of
          // 0x808080 into the SIGetType stack frame (the callback-corruption write).
          // pc = the EXACT storing instruction; log it (no dolphin round-trip). Other
          // 0xFFFFFFF{F,E,D} markers pass through to dolphin_interp.
          if ((inst >>> 0) === 0xFFFFFFFB) {
            if ((self.__swN = (self.__swN | 0) + 1) <= 64) {
              var _sm = new Int32Array(sharedMemoryRef.buffer);
              var _ctx = _sm[0x0250002C >> 2] >>> 0;          // real &ppc_state
              var _lr  = _ctx ? (_sm[(_ctx + 0x360) >> 2] >>> 0) : 0;  // LR (caller)
              var _r30 = _ctx ? (_sm[(_ctx + 0x8c) >> 2] >>> 0) : 0;   // r30 (store EA base)
              var _r1  = _ctx ? (_sm[(_ctx + 0x18) >> 2] >>> 0) : 0;   // r1 (sp)
              // SAVED caller-LR is on the guest stack at r1+0x2c (SIGetResponse
              // prologue: stw lr,4(old_r1); stwu -40). Read it via MEM1 base (SAB
              // 0x02500020), BE. That's the function that CALLED SIGetResponse.
              var _u8 = new Uint8Array(sharedMemoryRef.buffer);
              var _mem1 = _sm[0x02500020 >> 2] >>> 0;
              var _clrA = (_mem1 + ((_r1 + 0x2c) & 0x01FFFFFF)) >>> 0;
              var _clr = _mem1 ? (((_u8[_clrA] << 24) | (_u8[_clrA+1] << 16) | (_u8[_clrA+2] << 8) | _u8[_clrA+3]) >>> 0) : 0;
              postMessage({ cmd: 'print', txt: '[store-watch] 0x808080 storePC=0x' + (pc >>> 0).toString(16)
                + ' EA(r30)=0x' + _r30.toString(16) + ' r1=0x' + _r1.toString(16)
                + ' callerLR=0x' + _clr.toString(16) });
            }
            return;
          }
          call2(9, inst, pc);
        };
        env.ppc_check_exc   = (pc) => call1(10, pc);
        env.ppc_break_block = (pc, x) => call2(11, pc, x);
        env.ppc_read_tb     = (which) => call1(12, which);
        // Item 5 — env.ppc_hle_fire wired via mailbox cmd 14 (HleFire).
        // Routes to dolphin_hle_fire(pc, idx_and_type) -> next_pc. Counted
        // via mod._ppc_hle_fire_hits for the Phase 5 perf assertion.
        if (!mod._ppc_hle_fire_hits) mod._ppc_hle_fire_hits = 0;
        env.ppc_hle_fire    = (pc, it) => {
            mod._ppc_hle_fire_hits = (mod._ppc_hle_fire_hits | 0) + 1;
            return mod._ppc_worker_mailbox_call_sync2(14, pc >>> 0, it >>> 0) >>> 0;
        };
        if (!mod.bemental_regions) mod.bemental_regions = {};
        postMessage({ cmd: 'init-ack' });
        break;
      }
      case 'set-mode': {
        // Page flips perf-stub / native-HLE flags post-init. Used by the
        // boot-dispatcher cascade (set perfStub=false / hleNative=true
        // once dolphin signals "snapshot published") and perf-measurement
        // entry (set perfStub=true).
        if (!mod || typeof mod._ppc_worker_set_perf_stub !== 'function') {
          postMessage({ cmd: 'set-mode-nack', reason: 'setters not available' });
          return;
        }
        if (typeof data.perfStub === 'boolean') {
          mod._ppc_worker_set_perf_stub(data.perfStub ? 1 : 0);
        }
        if (typeof data.hleNative === 'boolean') {
          mod._ppc_worker_set_hle_check_native(data.hleNative ? 1 : 0);
        }
        postMessage({ cmd: 'set-mode-ack',
          perfStub: mod._ppc_worker_get_perf_stub() >>> 0,
          hleNative: mod._ppc_worker_get_hle_check_native() >>> 0 });
        break;
      }
      case 'load-aot': {
        // [AoT — Task 2] Pre-compiled PPC->WASM pack (gamecube/tools/aot/aot_emit.cpp).
        // data: { funcs: ArrayBuffer (5xu32 LE per fn: addr,offset,size,firstBlk,nBlks),
        //         blocks: ArrayBuffer (flat u32 LE block pcs), pack: ArrayBuffer (wasm concat) }.
        // Baked constants: ctx=0x02400000, mem1=0x1A4B7498 — VERIFY mem1 before enabling.
        try {
          const funcs = new Uint32Array(data.funcs);
          const blockPcs = new Uint32Array(data.blocks);
          const pack = new Uint8Array(data.pack);
          const map = new Map();
          const nf = funcs.length / 5;
          for (let f = 0; f < nf; f++) {
            const first = funcs[f * 5 + 3], nb = funcs[f * 5 + 4];
            for (let b = 0; b < nb; b++) map.set(blockPcs[first + b] >>> 0, (f << 8) | 0); // funcIdx in high bits; local idx recomputed below
          }
          // store local idx precisely: rebuild map with [funcIdx, localIdx]
          map.clear();
          for (let f = 0; f < nf; f++) {
            const first = funcs[f * 5 + 3], nb = funcs[f * 5 + 4];
            for (let b = 0; b < nb; b++) map.set(blockPcs[first + b] >>> 0, [f, b]);
          }
          self.__aot = { funcs, blockPcs, pack, map, instCache: new Array(nf), enabled: false,
                         bakedMem1: (data.mem1 >>> 0) || 0x1A4B7498 };
          postMessage({ cmd: 'print', txt: '[aot] pack loaded: ' + nf + ' funcs, '
            + map.size + ' blocks, ' + pack.length + ' bytes (mem1 verify pending)' });
        } catch (e) {
          postMessage({ cmd: 'print', txt: '[aot] load failed: ' + (e && e.message) });
        }
        break;
      }
      case 'update-mem': {
        // 2g: deferred MEM1 wiring. Page calls Module._dolphin_get_ram_addr
        // once dolphin's runtime is ready, posts here. ppc-worker's
        // self-compile path needs g_mem1_base/g_mem1_size set so it can
        // read guest instructions directly from SAB-mapped RAM.
        if (!mod) { postMessage({ cmd: 'update-mem-nack', reason: 'wasm not yet ready' }); return; }
        const newMem1Addr = (data.mem1Addr | 0) >>> 0;
        const newMem1Size = (data.mem1Size | 0) >>> 0;
        // [ppc-bridge] Bind to the REAL &ppc_state dolphin published (data.ppcStateAddr),
        // not the 0x02400000 sentinel the stubbed redirect never populated.
        const ppcStateAddr = (data.ppcStateAddr >>> 0) || ppcStateBase || 0x02400000;
        ppcStateBase = ppcStateAddr;
        const mailboxAddr  = mailboxBase || 0x02000000;
        mod._ppc_worker_init(ppcStateAddr, newMem1Addr, newMem1Size, mailboxAddr);
        mem1Base = newMem1Addr;
        mem1Size = newMem1Size;
        if (self.__aot) {
          // [indirect-base 2026-07-07] the pack no longer bakes mem1 — emitted code loads
          // the base from SAB 0x02500020 at runtime. Enable unconditionally.
          self.__aot.enabled = true;
          // [cfg-provenance 2026-07-09 — PERMANENT] Publish the ACTIVE configuration so every
          // acceptance run records what it verified (the dead-C-slice + stale-pack false-"done"
          // class). SAB 0x026B1840 = cfg bits (bit1=AoT enabled; bit0=C-slice loop, bit2=legacy
          // loop — set at loop entry), 0x026B1844 = pack byte length (regen fingerprint).
          {
            const _cv = new Uint32Array(sharedMemoryRef.buffer);
            _cv[0x026B1840 >> 2] = (_cv[0x026B1840 >> 2] | 2) >>> 0;
            _cv[0x026B1844 >> 2] = (self.__aot.pack ? self.__aot.pack.length : 0) >>> 0;
            // [pack-stamp 2026-07-10 — PERMANENT provenance] content fingerprint (FNV-1a over
            // every 4096th byte + length) @0x026B184C. A stale pack (emitter changed, pack not
            // regenerated — the 0x0600-channel contamination incident) is now VISIBLE in every
            // verify row, not discoverable only by byte-level audit.
            if (self.__aot.pack) {
              let h = 0x811c9dc5;
              const pk = self.__aot.pack;
              for (let i = 0; i < pk.length; i += 4096) { h ^= pk[i]; h = (h * 0x01000193) >>> 0; }
              h ^= pk.length; h = (h * 0x01000193) >>> 0;
              _cv[0x026B184C >> 2] = h >>> 0;
            }
          }
          postMessage({ cmd: 'print', txt: '[aot] ENABLED (indirect base; runtime mem1=0x'
            + (newMem1Addr >>> 0).toString(16) + ')' });
          if (self.__aot.enabled && !self.__aot.table) {
            // [aot-chain] Eager-instantiate the whole pack with a shared funcref table so
            // cross-function block exits tail-call in-wasm. Flat index in SAB @0x02700000:
            // (pc-0x80000000) -> ((table_slot+1)<<12 | entry_idx); entry cell @0x026B0904.
            try {
              const a = self.__aot;
              const nf = a.funcs.length / 5;
              a.table = new WebAssembly.Table({ initial: nf, element: 'anyfunc' });
              const baseEnv = mod.bemental_imports ? mod.bemental_imports.env : {};
              a.env = new Proxy({ aot_table: a.table }, {
                get: (t, k) => (t[k] !== undefined ? t[k] : baseEnv[k]),
                has: (t, k) => (k in t) || (k in baseEnv),
              });
              // zero the index span, then instantiate + fill
              const U = new Uint32Array(sharedMemoryRef.buffer);  // handler scope lacks u32
              const idxBase = 0x02700000 >>> 2;
              for (let w = 0; w < (0x120000 >> 2); w++) U[idxBase + w] = 0;
              // [#2 WPAR->ring 2026-07-11] The AoT binds env.ppc_write* at instantiation (below)
              // to whatever baseEnv holds NOW. The emcc glue set it to _dolphin_write8 (a mailbox
              // trampoline) — the source of the GXCopyDisp WPAR-store deadlock: the render thread's
              // WPAR stores park the worker on the unbounded mailbox wait. Override baseEnv.ppc_write*
              // HERE so the AoT binds a ring-routing version: WPAR bulk data -> the GP ring
              // (0x026C0000, consumer = dolphin_drain_gp_ring -> GPFifo::Write) with a BOUNDED
              // watermark Atomics.wait for ring space (consumer drains+notifies GP_TAIL; 2ms safety
              // poll) — NEVER a mailbox round-trip, NEVER dropped (per step-3 watermark: the 5-byte-
              // hole class is data loss, forbidden). Non-WPAR MMIO keeps the original trampoline. No
              // pack regen — the binding is a runtime JS ref resolved at line ~396. gpSent@0x026B1A3C.
              {
                const _origW8 = baseEnv.ppc_write8, _origW16 = baseEnv.ppc_write16, _origW32 = baseEnv.ppc_write32;
                const _gi = new Int32Array(sharedMemoryRef.buffer);
                const GPH = 0x026C0000 >> 2, GPT = 0x026C0004 >> 2, GPD = 0x026C0040 >> 2, GPCAP = 8192;
                const _isGpA = (addr) => (((addr & 0x0FFFFFFF) >>> 0) === 0x0C008000);
                const _ringPush = (width, val) => {
                  const h = Atomics.load(_gi, GPH) >>> 0;
                  let t = Atomics.load(_gi, GPT) >>> 0, spins = 0;
                  while (((h - t) >>> 0) >= (GPCAP - 16)) {   // bounded watermark; consumer drains+notifies
                    Atomics.wait(_gi, GPT, t | 0, 2);
                    t = Atomics.load(_gi, GPT) >>> 0;
                    if (++spins > 2000) break;                // ~4s absolute safety (consumer-dead only)
                  }
                  const slot = GPD + ((h & (GPCAP - 1)) * 2);
                  U[slot] = width; U[slot + 1] = val >>> 0;
                  Atomics.store(_gi, GPH, (h + 1) | 0);
                  U[0x026B1A3C >> 2] = ((U[0x026B1A3C >> 2] >>> 0) + 1) >>> 0;  // gpSent
                };
                baseEnv.ppc_write8  = (addr, val) => { if (_isGpA(addr)) { _ringPush(1, val); return; } return _origW8(addr, val); };
                baseEnv.ppc_write16 = (addr, val) => { if (_isGpA(addr)) { _ringPush(2, val); return; } return _origW16(addr, val); };
                baseEnv.ppc_write32 = (addr, val) => { if (_isGpA(addr)) { _ringPush(4, val); return; } return _origW32(addr, val); };
              }
              let okN = 0;
              for (let f = 0; f < nf; f++) {
                const off = a.funcs[f * 5 + 1], size = a.funcs[f * 5 + 2];
                const wmod = new WebAssembly.Module(a.pack.subarray(off, off + size));
                const inst = new WebAssembly.Instance(wmod, { env: a.env });
                a.instCache[f] = inst;
                a.table.set(f, inst.exports.region);
                const first = a.funcs[f * 5 + 3], nb = a.funcs[f * 5 + 4];
                for (let b = 0; b < nb; b++) {
                  const rel = (a.blockPcs[first + b] >>> 0) - 0x80000000;
                  if (rel < 0x120000) U[(0x02700000 + rel) >> 2] = (((f + 1) << 12) | b) >>> 0;
                }
                okN++;
              }
              postMessage({ cmd: 'print', txt: '[aot-chain] ' + okN + '/' + nf
                + ' functions instantiated, table+index live' });
            } catch (e) {
              self.__aot.enabled = false;
              postMessage({ cmd: 'print', txt: '[aot-chain] init failed, aot disabled: ' + (e && e.message) });
            }
          }
        }
        postMessage({ cmd: 'update-mem-ack', mem1Addr: newMem1Addr, mem1Size: newMem1Size });
        break;
      }
      case 'synth-perf': {
        // Item-3 perf-methodology: hand-build a ring of N synthetic
        // PowerPC blocks in MEM1, then start a wide-fanout dispatch
        // run that survives idle-skip and gives V8 enough sustained
        // per-block dispatch volume to fire TurboFan tier-up.
        //
        // Each ring slot is 2 instructions, 8 bytes apart:
        //   slot k @ guest VA (baseVA + k*8):
        //       +0:  ori r0,r0,0                    (PPC nop, 0x60000000)
        //       +4:  b   (baseVA + ((k+1) % N) * 8) (op18, link-not)
        // The branch encodes a relative offset = next_slot_va - cur_va.
        // Block decode in ppc_worker_compile_block terminates after
        // the op-18 branch (count=2). gekko_emit's emit_bx_impl
        // resolves the target and returns it as next-pc.
        //
        // Caller chooses baseVA in guest virtual space; the page reads
        // the dolphin MEM1 size and picks a high-end address well above
        // anything the OS is using during early boot.
        if (!inited) { postMessage({ cmd: 'synth-perf-nack', reason: 'not initialised' }); return; }
        if (!sharedMemoryRef) { postMessage({ cmd: 'synth-perf-nack', reason: 'no shared memory' }); return; }
        if (mem1Base === 0 || mem1Size === 0) { postMessage({ cmd: 'synth-perf-nack', reason: 'mem1 not wired' }); return; }
        const nSlots = ((data.nSlots | 0) >>> 0) || 256;
        const baseVA = (data.baseVA | 0) >>> 0;
        if ((baseVA & 0x3) !== 0) { postMessage({ cmd: 'synth-perf-nack', reason: 'baseVA not 4-aligned' }); return; }
        const ramMask = (mem1Size - 1) >>> 0;
        const basePhys = baseVA & ramMask;
        const sabAddr  = (mem1Base + basePhys) >>> 0;
        // Pack 2 BE u32s per slot, total nSlots*8 bytes. Need to write
        // them BE because gekko's compile path byte-swaps on read.
        const totalBytes = nSlots * 8;
        const u8 = new Uint8Array(sharedMemoryRef.buffer, sabAddr, totalBytes);
        const NOP = 0x60000000 >>> 0;  // ori r0,r0,0
        for (let k = 0; k < nSlots; ++k) {
          const slotVA   = (baseVA + k * 8) >>> 0;
          const nextVA   = (baseVA + ((k + 1) % nSlots) * 8) >>> 0;
          const offset   = (nextVA - (slotVA + 4)) | 0;  // PC-relative from branch instr
          // op-18 b: 0x48 LI[24] AA LK. LI = offset>>2, masked to 24 bits
          // sign-extended at execute time. AA=0, LK=0.
          const liMask   = (offset & 0x03FFFFFC) >>> 0;
          const branch   = (0x48000000 | liMask) >>> 0;
          // Write BE: byte 0 = bits [31:24].
          const o = k * 8;
          u8[o + 0] = (NOP >>> 24) & 0xff;
          u8[o + 1] = (NOP >>> 16) & 0xff;
          u8[o + 2] = (NOP >>>  8) & 0xff;
          u8[o + 3] = (NOP       ) & 0xff;
          u8[o + 4] = (branch >>> 24) & 0xff;
          u8[o + 5] = (branch >>> 16) & 0xff;
          u8[o + 6] = (branch >>>  8) & 0xff;
          u8[o + 7] = (branch       ) & 0xff;
        }
        postMessage({ cmd: 'synth-perf-ack', baseVA, nSlots, totalBytes, sabAddr });
        break;
      }
      case 'dispatch': {
        if (!inited) { postMessage({ cmd: 'dispatch-nack', reason: 'not initialised' }); return; }
        const next = mod._ppc_worker_dispatch((data.pc | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'dispatch-ack', next });
        break;
      }
      case 'sab-peek': {
        if (!mod) { postMessage({ cmd: 'sab-peek-nack', reason: 'wasm not yet ready' }); return; }
        const value = mod._ppc_worker_peek_u32((data.addr | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'sab-peek-ack', addr: data.addr, value });
        break;
      }
      case 'mailbox-demo': {
        if (!inited) { postMessage({ cmd: 'mailbox-demo-nack', reason: 'not initialised' }); return; }
        // ppc-worker pokes its mailbox slot with a sentinel. The page
        // then DataView-reads the same SAB offset to confirm the write
        // is visible cross-worker.
        mod._ppc_worker_mailbox_post_demo((data.sentinel | 0) >>> 0);
        postMessage({ cmd: 'mailbox-demo-ack', sentinel: data.sentinel });
        break;
      }
      case 'mmio-read-test': {
        // Phase 2c.4d/4e: ppc-worker → mailbox → dolphin → return value.
        if (!inited) { postMessage({ cmd: 'mmio-read-test-nack', reason: 'not initialised' }); return; }
        const value = mod._ppc_worker_mmio_read32((data.addr | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'mmio-read-test-ack', addr: data.addr, value });
        break;
      }
      case 'init-bemental-regions': {
        // Phase 2c.4f-3: stand up the JS-side region storage in
        // ppc-worker. After this, region-instantiate accepts wasm
        // bytes and stores the resulting Instance in mod.bemental_regions[r],
        // analogous to dolphin's block_cache.cpp::region_relink path.
        if (!mod) { postMessage({ cmd: 'init-bemental-regions-nack', reason: 'wasm not yet ready' }); return; }
        if (!mod.bemental_regions) mod.bemental_regions = {};
        const had_env = (mod.bemental_imports && mod.bemental_imports.env);
        postMessage({ cmd: 'init-bemental-regions-ack', had_env: !!had_env });
        break;
      }
      case 'region-instantiate': {
        // Receives:
        //   regionIdx: 0..7
        //   bytes: ArrayBuffer of the wasm module
        //   imports: 'env' (use mod.bemental_imports.env) or 'none' (no imports)
        //   pcKeys: optional Uint32Array of PCs for pcMap
        // Stores in mod.bemental_regions[regionIdx].
        if (!mod) { postMessage({ cmd: 'region-instantiate-nack', reason: 'wasm not yet ready' }); return; }
        if (!mod.bemental_regions) mod.bemental_regions = {};
        try {
          const bytes = new Uint8Array(data.bytes);
          const wmod = new WebAssembly.Module(bytes);
          const importObj = (data.imports === 'env' && mod.bemental_imports)
            ? { env: mod.bemental_imports.env }
            : {};
          const inst = new WebAssembly.Instance(wmod, importObj);
          const region = { instance: inst, exports: inst.exports };
          if (data.pcKeys) {
            const pcMap = new Map();
            const arr = new Uint32Array(data.pcKeys);
            for (let i = 0; i < arr.length; ++i) pcMap.set(arr[i] >>> 0, i);
            region.pcMap = pcMap;
            region.nFuncs = arr.length;
          }
          mod.bemental_regions[data.regionIdx | 0] = region;
          const exportNames = Object.keys(inst.exports);
          postMessage({ cmd: 'region-instantiate-ack', regionIdx: data.regionIdx, exportNames });
        } catch (e) {
          postMessage({ cmd: 'region-instantiate-nack', reason: 'instantiate failed: ' + (e && e.message ? e.message : String(e)) });
        }
        break;
      }
      case 'region-call-export': {
        // Calls a named export from a stored region. For test-mode
        // bytes the export takes no args and returns i32; we just
        // return the value.
        if (!mod || !mod.bemental_regions) { postMessage({ cmd: 'region-call-export-nack', reason: 'no regions' }); return; }
        const region = mod.bemental_regions[data.regionIdx | 0];
        if (!region || !region.exports[data.exportName]) {
          postMessage({ cmd: 'region-call-export-nack', reason: 'no such export: ' + data.exportName });
          return;
        }
        try {
          const value = region.exports[data.exportName]() >>> 0;
          postMessage({ cmd: 'region-call-export-ack', regionIdx: data.regionIdx, exportName: data.exportName, value });
        } catch (e) {
          postMessage({ cmd: 'region-call-export-nack', reason: 'call failed: ' + (e && e.message ? e.message : String(e)) });
        }
        break;
      }
      case 'env-call-test': {
        // Phase 2c.4f-2 verify: invoke a binding from mod.bemental_imports.env
        // by NAME. If cmd 8/10/12 etc. handlers in dolphin are wired, they
        // return real values; if not, we get 0 and a spinning Atomics.wait.
        if (!inited || !mod.bemental_imports) { postMessage({ cmd: 'env-call-test-nack', reason: 'env not ready' }); return; }
        const env = mod.bemental_imports.env;
        const fn = env[data.name];
        if (typeof fn !== 'function') { postMessage({ cmd: 'env-call-test-nack', reason: 'no such fn: ' + data.name }); return; }
        const reply = fn((data.arg0 | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'env-call-test-ack', name: data.name, arg0: data.arg0, reply });
        break;
      }
      case 'setup-bemental-env': {
        // Phase 2c.4f-2: build the env import object that JIT-emitted
        // blocks will resolve against when instantiated in ppc-worker
        // (Phase 2c.4f-3). Each binding mailboxes its request via
        // ppc_worker_mailbox_call_sync — dolphin executes the
        // corresponding dolphin_* function in its inner-iter poll.
        // Cmd codes match gamecube/ppc-worker/sab_layout.h::MailboxCmd.
        if (!inited) { postMessage({ cmd: 'setup-bemental-env-nack', reason: 'not initialised' }); return; }
        if (!mod.bemental_imports) mod.bemental_imports = { env: {} };
        const env = mod.bemental_imports.env;
        const call1 = (cmd, a) => mod._ppc_worker_mailbox_call_sync(cmd, a >>> 0) >>> 0;
        const call2 = (cmd, a, b) => { mod._ppc_worker_mailbox_call_sync2(cmd, a >>> 0, b >>> 0); };
        env.memory          = sharedMemoryRef;
        // [poll-target 2026-07-09] record the last slow-path MMIO read (addr + seq) so the
        // EE=0 poll handler can DISCRIMINATE beam polls (VI range -> smooth-step) from
        // device-completion polls (DSP/EXI/AI -> jump-to-next-event). Only MMIO routes
        // through env reads, so a fresh addr here IS the polled register.
        // [mmio-read-fastpath 2026-07-17] The oracle proved the audio-init stall is THROUGHPUT: every
        // guest ISR MMIO read is a blocking worker->dolphin mailbox round-trip (call1(4,addr)), so the
        // ARAM ARQ-chain runs ~2/s vs native ~400/s and gc freezes at 156. Read the two HOT ISR
        // registers straight from a dolphin-maintained SAB mirror (no round-trip): PI cause 0xCC003000
        // @0x026B27D0 (ProcessorInterface::UpdateException release-store), DSP_CONTROL 0xCC00500A
        // @0x026B27D4 (DSP::UpdateInterrupts). Only post-takeover (cpu_owner==1); the fixed 512MB SAB
        // never grows so this view stays valid. Atomics.load = acquire, pairs with dolphin's release.
        self.__mmr = self.__mmr || new Int32Array(sharedMemoryRef.buffer);
        env.ppc_read8       = (addr) => { self.__lastMmioRdAddr = addr >>> 0; self.__lastMmioRdSeq = (self.__lastMmioRdSeq | 0) + 1; return call1(2, addr); };
        env.ppc_read16      = (addr) => {
          const a = addr >>> 0;
          if (a === 0xCC00500A && Atomics.load(self.__mmr, 0x026A0000 >> 2) === 1) {
            Atomics.add(self.__mmr, 0x026B27DC >> 2, 1);                  // [fastpath-hit] DSP_CONTROL
            return Atomics.load(self.__mmr, 0x026B27D4 >> 2) & 0xFFFF; }  // DSP_CONTROL fast-path
          self.__lastMmioRdAddr = a; self.__lastMmioRdSeq = (self.__lastMmioRdSeq | 0) + 1; return call1(3, a); };
        env.ppc_read32      = (addr) => {
          const a = addr >>> 0;
          if (a === 0xCC003000 && Atomics.load(self.__mmr, 0x026A0000 >> 2) === 1) {
            Atomics.add(self.__mmr, 0x026B27D8 >> 2, 1);                  // [fastpath-hit] PI cause
            return Atomics.load(self.__mmr, 0x026B27D0 >> 2) >>> 0; }     // PI cause fast-path
          self.__lastMmioRdAddr = a; self.__lastMmioRdSeq = (self.__lastMmioRdSeq | 0) + 1; return call1(4, a); };
        // Item 6 Stage 2 — writes go either via mailbox (W1, default) or
        // SAB pending-writes ring (W2, gated by `useWriteRing`).
        installWriteEnv(env, call2);
        env.ppc_hle_check   = (pc) => call1(8, pc);
        env.ppc_interp      = (inst, pc) => {
          // [store-watch 2026-06-29 TEMP] BUG 2: marker 0xFFFFFFFB = a 32-bit store of
          // 0x808080 into the SIGetType stack frame (the callback-corruption write).
          // pc = the EXACT storing instruction; log it (no dolphin round-trip). Other
          // 0xFFFFFFF{F,E,D} markers pass through to dolphin_interp.
          if ((inst >>> 0) === 0xFFFFFFFB) {
            if ((self.__swN = (self.__swN | 0) + 1) <= 64) {
              var _sm = new Int32Array(sharedMemoryRef.buffer);
              var _ctx = _sm[0x0250002C >> 2] >>> 0;          // real &ppc_state
              var _lr  = _ctx ? (_sm[(_ctx + 0x360) >> 2] >>> 0) : 0;  // LR (caller)
              var _r30 = _ctx ? (_sm[(_ctx + 0x8c) >> 2] >>> 0) : 0;   // r30 (store EA base)
              var _r1  = _ctx ? (_sm[(_ctx + 0x18) >> 2] >>> 0) : 0;   // r1 (sp)
              // SAVED caller-LR is on the guest stack at r1+0x2c (SIGetResponse
              // prologue: stw lr,4(old_r1); stwu -40). Read it via MEM1 base (SAB
              // 0x02500020), BE. That's the function that CALLED SIGetResponse.
              var _u8 = new Uint8Array(sharedMemoryRef.buffer);
              var _mem1 = _sm[0x02500020 >> 2] >>> 0;
              var _clrA = (_mem1 + ((_r1 + 0x2c) & 0x01FFFFFF)) >>> 0;
              var _clr = _mem1 ? (((_u8[_clrA] << 24) | (_u8[_clrA+1] << 16) | (_u8[_clrA+2] << 8) | _u8[_clrA+3]) >>> 0) : 0;
              postMessage({ cmd: 'print', txt: '[store-watch] 0x808080 storePC=0x' + (pc >>> 0).toString(16)
                + ' EA(r30)=0x' + _r30.toString(16) + ' r1=0x' + _r1.toString(16)
                + ' callerLR=0x' + _clr.toString(16) });
            }
            return;
          }
          call2(9, inst, pc);
        };
        env.ppc_check_exc   = (pc) => call1(10, pc);
        env.ppc_break_block = (pc, x) => call2(11, pc, x);
        env.ppc_read_tb     = (which) => call1(12, which);
        // Item 5 — env.ppc_hle_fire wired via mailbox cmd 14 (HleFire).
        if (!mod._ppc_hle_fire_hits) mod._ppc_hle_fire_hits = 0;
        env.ppc_hle_fire    = (pc, it) => {
            mod._ppc_hle_fire_hits = (mod._ppc_hle_fire_hits | 0) + 1;
            return mod._ppc_worker_mailbox_call_sync2(14, pc >>> 0, it >>> 0) >>> 0;
        };
        const keys = Object.keys(env).sort();
        postMessage({ cmd: 'setup-bemental-env-ack', keys, count: keys.length });
        break;
      }
      case 'mmio-rw-suite': {
        // Phase 2c.4f-1: exercise read8/read16/write8/write16/write32
        // through the mailbox. dolphin handles each via dolphin_read*/
        // dolphin_write* into Memory.GetMMIOMapping(). This validates
        // the new arg1 slot and all six cmd handlers.
        if (!inited) { postMessage({ cmd: 'mmio-rw-suite-nack', reason: 'not initialised' }); return; }
        postMessage({ cmd: 'rw-suite-debug', stage: 'entered' });
        const PI_MASK = 0xCC003004;
        // Read current PI mask (32-bit).
        const mask32 = mod._ppc_worker_mmio_read32(PI_MASK) >>> 0;
        postMessage({ cmd: 'rw-suite-debug', stage: 'after-read32', value: mask32 });
        // Read first byte of mask (8-bit). Should be the LOW byte
        // (PI mask is little-endian on the wire from MMIO ops? Actually
        // PowerPC is big-endian — the high byte of the u32 is at the
        // lowest offset). dolphin_read8(addr) returns the byte at addr.
        const byte0 = mod._ppc_worker_mmio_read8(PI_MASK)  >>> 0;
        const half0 = mod._ppc_worker_mmio_read16(PI_MASK) >>> 0;
        // [bisect TEMP] PI-mask write-back DISABLED. The "re-write the SAME mask"
        // is only idempotent if nothing changes it in between — but the read (line
        // 434) and this write are several mailbox round-trips apart, so the
        // apploader's __OSInterruptInit can set the mask in that window and we'd
        // clobber it. Testing whether this race is the runaway corruptor.
        // mod._ppc_worker_mmio_write32(PI_MASK, mask32);
        const mask32b = mask32;
        postMessage({ cmd: 'mmio-rw-suite-ack',
          mask32, byte0, half0, mask32b });
        break;
      }
      case 'run': {
        // Phase 2c.4f-4: replicate JitWasm::Run()'s inner-iter loop.
        // For each iteration: look pc up in some region's pcMap, call
        // the corresponding block export (named "block<idx>"), use
        // its return value as the next pc, repeat. Region lookup
        // iterates the small (≤8) region table — bementalJIT's real
        // bemental::classify() is constant-time on pc bits; deferred
        // until the multi-region storage carries a classify cache.
        //
        // Exit reasons (string):
        //   'unmapped'         — pc not in any region's pcMap (next
        //                         step in 4f-5 will mailbox a
        //                         CompileBlock to dolphin).
        //   'no-block-export'  — region.exports['block<idx>'] missing.
        //   'block-trap: ...'  — wasm trap inside dispatched block.
        //   'max-iters'        — iter budget exhausted (no exit cond).
        if (!mod || !mod.bemental_regions) { postMessage({ cmd: 'run-nack', reason: 'no regions' }); return; }
        let pc = (data.startPc | 0) >>> 0;
        const maxIters = ((data.maxIters | 0) >>> 0) || 100;
        const regions = mod.bemental_regions;
        const compileOnMiss = !!data.compileOnMiss;
        let iters = 0;
        let exitReason = 'max-iters';
        let compileCalls = 0;
        let totalCompileBytes = 0;
        for (; iters < maxIters; ++iters) {
          let region = null, idx = -1;
          for (const k in regions) {
            const r = regions[k];
            if (r && r.pcMap && r.pcMap.has(pc)) { region = r; idx = r.pcMap.get(pc); break; }
          }
          if (!region) {
            if (!compileOnMiss) { exitReason = 'unmapped'; break; }
            // 4f-5 page-mediated CompileBlock (cmd 13). Page polls the
            // mailbox slot, synthesizes wasm bytes, writes them into
            // SAB scratch, and replies with (offset, size, region<<16|fn)
            // via reply + reply_extra1 + reply_extra2 fields. ppc-worker
            // copies bytes out of SAB and instantiates locally. Real
            // bementalJIT-driven delivery comes once the dolphin compile
            // path is wired (still pending — page synthesizes the test
            // stub for now).
            const bytesOffset = mod._ppc_worker_mailbox_call_sync(13, pc) >>> 0;
            const bytesSize   = mod._ppc_worker_peek_u32(mailboxBase + 24) >>> 0;
            const packed      = mod._ppc_worker_peek_u32(mailboxBase + 28) >>> 0;
            ++compileCalls;
            totalCompileBytes += bytesSize;
            if (bytesSize === 0) { exitReason = 'compile-empty'; break; }
            // 2f.0: reply_extra2 packs cycles + region + fn:
            //   bits 0-15:  fn idx (16-bit)
            //   bits 16-23: region idx (8-bit)
            //   bits 24-31: cycle count (8-bit, 0..255)
            // cycles = 0 means stub or pre-boot fallback (treat as 1 to
            // keep downcount progressing).
            const regionIdx   = (packed >>> 16) & 0xFF;
            const fnIdx       = packed & 0xFFFF;
            const blockCycles = ((packed >>> 24) & 0xFF) || 1;
            try {
              const bytes = new Uint8Array(sharedMemoryRef.buffer, bytesOffset, bytesSize).slice();
              const wmod = new WebAssembly.Module(bytes);
              const importObj = mod.bemental_imports
                ? { env: mod.bemental_imports.env } : {};
              const inst = new WebAssembly.Instance(wmod, importObj);
              if (!regions[regionIdx]) {
                regions[regionIdx] = { instance: inst, exports: inst.exports, pcMap: new Map(), cycleMap: new Map(), nFuncs: 0 };
              } else {
                regions[regionIdx].instance = inst;
                regions[regionIdx].exports = inst.exports;
                if (!regions[regionIdx].pcMap) regions[regionIdx].pcMap = new Map();
                if (!regions[regionIdx].cycleMap) regions[regionIdx].cycleMap = new Map();
              }
              regions[regionIdx].pcMap.set(pc >>> 0, fnIdx);
              regions[regionIdx].cycleMap.set(pc >>> 0, blockCycles);  // 2f.0
              regions[regionIdx].nFuncs = Math.max(regions[regionIdx].nFuncs || 0, fnIdx + 1);
              region = regions[regionIdx];
              idx = fnIdx;
            } catch (e) {
              exitReason = 'compile-instantiate: ' + (e && e.message ? e.message : String(e));
              break;
            }
          }
          // bementalJIT-emitted modules export the entrypoint as `run`
          // (see gekko_emit.cpp::4006). Test wasms (4f-4 hand-built,
          // 4f-5 page-stub) export per-block names like `block0`. Fall
          // back from one to the other so both shapes dispatch.
          const fn = region.exports['block' + idx] || region.exports.run;
          if (typeof fn !== 'function') { exitReason = 'no-block-export'; break; }
          try {
            pc = fn() >>> 0;
          } catch (e) {
            exitReason = 'block-trap: ' + (e && e.message ? e.message : String(e));
            break;
          }
        }
        postMessage({ cmd: 'run-ack', iters, lastPc: pc, exitReason, compileCalls, totalCompileBytes });
        break;
      }
      case 'run-continuous': {
        // 2f.1: continuous dispatch loop. Drives ppc-worker as the
        // PowerPC dispatch source — reads live PC from SAB ppc_state
        // (post-2e.4), dispatches block, decrements downcount, repeats
        // until a natural exit (downcount<=0, exception, idle-skip,
        // stop-flag). Replaces the maxIters-bounded 'run' handler for
        // production use; the bounded 'run' stays for verification.
        //
        // Exit reasons:
        //   'downcount-exhausted' — dolphin needs to advance scheduler
        //   'exception-pending'   — Exceptions != 0; dolphin handles vector
        //   'idle-skip'           — same pc > 100 dispatches; dolphin's
        //                            CoreTiming::Idle() should fast-forward
        //   'unmapped'            — block lookup miss + compileOnMiss=false
        //   'stop-flag'           — external (page or dolphin) set the
        //                            yield flag at SAB[0x02500000]
        //   'safety-cap'          — hit the hard cap (sanity bound)
        //   'block-trap: ...'     — wasm trap inside dispatched block
        if (!mod || !mod.bemental_regions) { postMessage({ cmd: 'run-continuous-nack', reason: 'no regions' }); return; }
        if (!sharedMemoryRef) { postMessage({ cmd: 'run-continuous-nack', reason: 'no shared memory' }); return; }
        const regions = mod.bemental_regions;
        const compileOnMiss = !!data.compileOnMiss;
        const safetyCap = ((data.safetyCap | 0) >>> 0) || 100000;
        // Phase 3a.4 — feature flag for the merged-region dispatch path.
        // When `mergedRegion: true`, dispatch goes through the C-side
        // ppc_worker_region_dispatch_pc which uses BlockCache::region_dispatch
        // (single merged WASM module per region; V8 cross-block inlining
        // possible since blocks are in the same instance). Falls through
        // to compile_and_accumulate + relink_region_if_due on miss.
        // When false: legacy 2g per-block-instance path (unchanged).
        const mergedRegion = !!data.mergedRegion;
        // Phase 3a.5 — relink cadence. Tighter than research's 256-iter
        // suggestion: at 110 blocks/sec baseline, 256 iters could be
        // multiple seconds, leaving the merged path stuck waiting for
        // first module. Every 32 iters means the first 64 misses (ie the
        // first compile-storm) trigger relink within ~2 ms even at the
        // legacy throughput rate. Cost: 32× more region_should_relink
        // calls — each is ≤9 hashmap-size + time-delta checks (cheap).
        const relinkCheckMask = 0x1f;  // every 32 iters
        // 2f.6: perf-measurement mode bypasses downcount/exception/idle
        // termination so we can clock raw dispatch throughput. Still
        // honors stop-flag and safetyCap.
        const ignoreDowncount = !!data.ignoreDowncount;
        const wallTimeMs = (data.wallTimeMs | 0) || 0;
        // Item-3 perf-methodology fix: disable the samePcCount idle-skip
        // exit so we can keep dispatching past the synthetic boot's
        // degenerate-loop convergence. Required to let V8 see sustained
        // per-block dispatch counts (>10K iters/block) and tier up via
        // TurboFan. ?ppcperfsynth=1 path always sets this; synthetic
        // ring's wide PC fanout independently keeps lastPc moving so
        // the flag is belt-and-suspenders for that path.
        const disableIdleSkip = !!data.disableIdleSkip;

        // Phase 3a-fix (Option A): swap env.ppc_* imports to no-op stubs
        // when in perf-measurement mode. Background: every env.ppc_*
        // import calls _ppc_worker_mailbox_call_sync which Atomics.waits
        // for dolphin to drain the mailbox. dolphin's pthread is busy
        // in _run_iter_batch(100K) during boot and NEVER drains, so any
        // dispatched block that hits an env.ppc_* import hangs forever
        // (verified: iter=1 block at 0x80003254 hung in the 2g test).
        // Stubs return 0 (or void) immediately — loop progresses. The
        // dispatched code's side effects are wrong (memory reads return
        // 0) but that was already true under ignoreDowncount: ppc-worker
        // runs concurrent with dolphin which owns canonical state.
        // Throughput measurement IS the only goal here.
        //
        // Must mutate env BEFORE any new WebAssembly.Instance is created
        // in the loop — instances capture import refs at instantiation.
        // We swap on the SAME object (mod.bemental_imports.env) so any
        // future instances pick up the stubs.
        //
        // No restore: perf mode is one-shot per session. After the loop
        // exits the stubs stay, but no other dispatch path runs.
        if (ignoreDowncount && mod.bemental_imports && mod.bemental_imports.env
            && !mod.bemental_imports.env._stubbed_for_perf) {
          const env = mod.bemental_imports.env;
          env.ppc_read8       = () => 0;
          env.ppc_read16      = () => 0;
          env.ppc_read32      = () => 0;
          env.ppc_write8      = () => {};
          env.ppc_write16     = () => {};
          env.ppc_write32     = () => {};
          env.ppc_hle_check   = () => 0;
          env.ppc_interp      = () => {};
          env.ppc_check_exc   = () => 0;
          env.ppc_break_block = () => {};
          env.ppc_read_tb     = () => 0;
          // Item 5: in ignoreDowncount perf mode, dolphin owns canonical
          // state and HLE bypass is acceptable. Stub returns pc unchanged
          // so the block falls through. Real boot wires this through the
          // mailbox at the init-ack / setup-bemental-env paths above.
          env.ppc_hle_fire    = (pc /*, it*/) => pc | 0;
          env._stubbed_for_perf = true;
          postMessage({ cmd: 'print',
            txt: '[ppc-worker] env.ppc_* stubbed for perf-measurement mode '
               + '(returns 0; correctness sacrificed for throughput)' });
        }
        const wallStart = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        // PowerPCState SAB offsets per ppc_worker_main.cpp layout comment.
        const PPC_STATE_BASE   = ppcStateBase;  // [ppc-bridge] real &ppc_state (was 0x02400000 sentinel)
        // [base-publish 2026-07-07] publish the ACTUAL base this loop uses (SAB 0x026B0E98)
        // — own view: u32 is declared LATER in this scope (TDZ — the recorded trap, 5th hit).
        new Uint32Array(sharedMemoryRef.buffer)[0x026B0E98 >> 2] = PPC_STATE_BASE >>> 0;
        const OFFSET_PC        = 0x000;
        const OFFSET_NPC       = 0x004;   // ppc_offsets.h: NPC = 0x004 (SRR0 source on async-int delivery)
        const OFFSET_MSR       = 0x2E0;
        const OFFSET_EXC       = 0x2EC;
        const OFFSET_DOWNCOUNT = 0x2F0;
        // 2f.2 reserves SAB[0x02500000] for the dolphin yield flag
        // (page sets → dolphin returns from Run()). ppc-worker uses
        // a separate stop flag at +4 so the two signals don't conflict.
        const STOP_FLAG_ADDR   = 0x02500004;
        const u32 = new Uint32Array(sharedMemoryRef.buffer);
        const i32 = new Int32Array(sharedMemoryRef.buffer);  // downcount is signed
        // Initial PC: caller-supplied wins, else read from SAB ppc_state.
        let pc;
        if (typeof data.startPc === 'number') {
          pc = (data.startPc | 0) >>> 0;
          u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] = pc;
        } else {
          pc = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
        }
        // 2f.6 diag: log what ppc-worker sees at the ppc_state offsets.
        // If page sees 0xcafe1234 here but dolphin writes real PCs in
        // the same address, the views are inconsistent.
        const _diag_pc  = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
        const _diag_msr = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
        const _diag_dc  = i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2];
        const _diag_buf = sharedMemoryRef ? sharedMemoryRef.buffer.byteLength : 0;
        postMessage({ cmd: 'print',
          txt: '[ppc-worker-diag] SAB[0x02400000+0]=0x' + _diag_pc.toString(16)
             + ' MSR=0x' + _diag_msr.toString(16)
             + ' downcount=' + _diag_dc
             + ' bufBytes=' + _diag_buf });
        // [determinize-boot / atomics-only loop 2026-07-08] Internal re-engage loop:
        // on a benign slice exit while the worker still owns the CPU, service dolphin
        // SYNCHRONOUSLY via the mailbox (Atomics) a fixed count, then re-run the slice —
        // NO postMessage ack → page setTimeout → re-engage round-trip (the residual
        // async-ordering entropy after the 4 wall-constant fixes). The page keeps control
        // via the owner flag (0x026A0000) + stop flag (0x02500004): clearing owner or
        // setting stop drops out of the benign list → posts ack → breaks to the switch.
        let _sliceLoop = true;
        while (_sliceLoop) {
        let iters = 0;
        let compileCalls = 0;
        let totalCompileBytes = 0;
        let exitReason = 'safety-cap';
        let lastPc = 0xFFFFFFFF;
        let samePcCount = 0;
        // CT-fire wall-time clock. Previously gated on `iters & (CT_FIRE_EVERY-1)`
        // which assumed ~16K disp/sec → 60 Hz fire. At observed ~9.5K disp/sec
        // (phase_2e_cutover_works_cache_bottleneck.md) that gave ~37 Hz; lower
        // dispatch rates degrade proportionally. Same bug class as dreamcast
        // rec_wasm.cpp:1296 SPG raise gate (s_spg_tick & 0x3F → 7.5 Hz). Fixed
        // there 2026-05-17 by switching to emscripten_get_now() ≥16ms wall gate
        // → 7.6× throughput, see dreamcast_spg_walltime_gate_2026_05_17.md.
        // Mirror that pattern here.
        let lastCtFireMs = wallStart;
        const CT_FIRE_INTERVAL_MS = 16.0;  // ~60 Hz, matches native VI cadence.
        // [determinize-boot 2026-07-08] CT-fire on GUEST CYCLES, not wall ms — wall-timed
        // event firing made the post-takeover trajectory nondeterministic (two-run face
        // divergence). 20000 cyc ~= one slice; ties device-event cadence to guest ticks.
        let lastCtFireCycles = 0;
        const CT_FIRE_CYCLES = 20000;
        // Item 7 Phase II — periodically drain DEC (and Phase III hybrid)
        // events from the SAB shared CT queue. The fire is a no-op if
        // the queue is empty, so calling every N iters is cheap. N=256
        // keeps the latency well under one VI half-line on any clock.
        // Read global timer from SAB header (dolphin publishes via
        // CoreTiming::Advance hooks). Init guarded by ppc_worker_ct_queue_init
        // — JS-side caller is responsible for invoking it once before
        // run-continuous; we tolerate "not ready" by reading 0 timer
        // and dolphin's publish lighting it up over time.
        const CT_BASE = 0x02680000;
        const CT_OFF_GTL = 0x08;
        const CT_OFF_GTH = 0x0C;
        const CT_QUEUE_RECORDS_OFF = 0x80;
        const CT_QUEUE_CAPACITY = 256;
        const CT_REC_BYTES = 24;
        const CT_FLAG_VALID = 0x1;
        const CT_FLAG_REMOVED = 0x8;
        const CT_FIRE_EVERY = 256;
        // Item 7 sleep-tick policy. Mirror of dolphin's JitWasm path:
        // when same-PC ≥ 1024 AND next event distance > 1024 cycles,
        // advance SAB global_timer directly to next_event-1. PC-agnostic
        // — works for any unrecognized polling loop. ppc-worker walks
        // the shared queue itself to find the minimum non-tombstoned
        // event time. dolphin polls the SAB timer in Advance() under
        // Phase IV and adopts it.
        const SLEEP_TICK_THRESHOLD = 1024;
        let sleepTickCount = 0;
        const findNextEventCycles = () => {
          let minLo = 0xFFFFFFFF, minHi = 0xFFFFFFFF, anyValid = false;
          for (let i = 0; i < CT_QUEUE_CAPACITY; ++i) {
            const recBase = CT_BASE + CT_QUEUE_RECORDS_OFF + i * CT_REC_BYTES;
            const flags = u32[(recBase + 16) >> 2] >>> 0;
            if ((flags & CT_FLAG_VALID) === 0) continue;
            if ((flags & CT_FLAG_REMOVED) !== 0) continue;
            const tLo = u32[(recBase + 0) >> 2] >>> 0;
            const tHi = u32[(recBase + 4) >> 2] >>> 0;
            if (!anyValid || tHi < minHi || (tHi === minHi && tLo < minLo)) {
              minLo = tLo; minHi = tHi; anyValid = true;
            }
          }
          // [ct-next] fold in dolphin's hybrid-queue head (published by Advance at
          // 0x026B0910/14/18) — VI/ARAM/DSP live there; the pure mirror never sees them.
          if ((u32[0x026B0918 >> 2] >>> 0) === 1) {
            const dLo = u32[0x026B0910 >> 2] >>> 0;
            const dHi = u32[0x026B0914 >> 2] >>> 0;
            if (!anyValid || dHi < minHi || (dHi === minHi && dLo < minLo)) {
              minLo = dLo; minHi = dHi; anyValid = true;
            }
          }
          return anyValid ? { lo: minLo, hi: minHi } : null;
        };
        // Item 7 Phase IV: slice-bound cycles cap. Before entering
        // dispatch, ask the C side for min(downcount, next_event - now,
        // PHASE4_MAX_SLICE) in cycles. Track cycles burned across blocks;
        // exit when sliceCyclesBurned >= cap. commit_slice (well, the
        // inline advance_global_timer + fire_due_pure equivalent at end
        // of case) runs at slice exit to atomically advance global_timer
        // + fire due events. When the C export is missing (older worker
        // build), cap=0 disables Phase IV slicing and the loop falls back
        // to pre-Phase-IV exit conditions (downcount/idle-skip/etc.).
        // Phase IV — under cadence handoff dolphin's CoreTiming::Advance no
        // longer runs (we routed run_iter_batch to service_iter), so nobody
        // replenishes downcount. ppc-worker is sole owner — prime it before
        // the slice so the per-block Atomics.sub has something to burn.
        // 20000 = MAX_SLICE_LENGTH per CoreTiming.cpp:55.
        if (typeof mod._ppc_worker_set_downcount === 'function') {
          mod._ppc_worker_set_downcount(20000);
        }
        const sliceCyclesCap = (typeof mod._ppc_worker_slice_budget === 'function')
            ? (mod._ppc_worker_slice_budget() >>> 0) : 0;
        let sliceCyclesBurned = 0;
        // Track cycles already pushed into SAB global_timer mid-slice so
        // per-iter CT advance + slice-end advance don't double-count.
        // Phase 2e fix: under cutover, dolphin's libretro frame loop is
        // the only outer CoreTiming::Advance — but it ticks every ~16ms
        // wall, during which ppc-worker burns ~750K dispatches. Events
        // scheduled mid-slice never fire mid-slice unless we advance
        // global_timer + run fire_due_pure incrementally.
        let cyclesAdvancedSoFar = 0;
        // Phase IV diag: SAB counters so page can see slice progress
        // without waiting for ack messages. 0x025010E0..025010FF reserved.
        const PH4_DIAG_ITERS  = 0x025010E0;
        const PH4_DIAG_PC     = 0x025010E4;
        const PH4_DIAG_DC     = 0x025010E8;
        const PH4_DIAG_EXC    = 0x025010EC;
        const PH4_DIAG_EXIT   = 0x025010F0;  // 0=running, 1=exited
        Atomics.store(i32, PH4_DIAG_EXIT >> 2, 0);

        // Phase 2e Step 2: feature-flagged C-side dispatch loop. When
        // Module.PPC_WORKER_USE_C_SLICE === 1, the inner per-block
        // while-loop is replaced by repeated calls to the C function
        // _ppc_worker_run_slice which owns the iteration. ExitInfo is
        // returned via SAB (no BigInt needed): SAB[0x025000A0]=iters,
        // SAB[0x025000A4]=reason. All JS-side housekeeping (relink-due
        // checks, ack postMessage, slice-budget commit) stays here,
        // wrapped OUTSIDE the C call. Default OFF — flag must be
        // explicitly enabled (Module.PPC_WORKER_USE_C_SLICE = 1) before
        // posting 'run-continuous' to opt in.
        //
        // Exit reasons (mirror C enum PpcSliceExitReason):
        //   0 = downcount-exhausted (downcount <= 0)   → exit slice
        //   1 = stop-flag (SAB stop set)               → exit slice
        //   2 = exception-pending (Exceptions != 0)    → cmd 10 + re-enter
        //   3 = safety-cap (1M iters)                  → re-enter (just sliced)
        //   4 = region-miss (compile path needed)      → compile + re-enter
        if (mod && mod.PPC_WORKER_USE_C_SLICE === 1
            && typeof mod._ppc_worker_run_slice === 'function') {
          const EXIT_ITERS_ADDR  = 0x025000A0;
          const EXIT_REASON_ADDR = 0x025000A4;
          const REASON_DOWNCOUNT  = 0;
          const REASON_STOP_FLAG  = 1;
          const REASON_EXCEPTION  = 2;
          const REASON_SAFETY_CAP = 3;
          const REASON_REGION_MISS = 4;
          // Per-C-call cap. Smaller than safetyCap so JS housekeeping
          // (relink-due check + diag publish) runs often enough to keep
          // the merged-region path fresh and the page observable.
          const C_SLICE_CAP = 4096;
          // mailbox cmd 10 helper (mirrors the call1 helper defined in
          // 'setup-bemental-env'; not in scope here, so call mailbox
          // sync directly).
          const _mboxCall10 = (pcArg) =>
            mod._ppc_worker_mailbox_call_sync(10, pcArg >>> 0) >>> 0;
          let exitedSlice = false;
          while (!exitedSlice && iters < safetyCap) {
            // Outer-loop housekeeping — same checks JS used to do per
            // iter, now done per C-slice. Cheap enough to run every
            // entry (the merged-region force-relink kicks once iters<16
            // and not at all after; relink_region_if_due is a few
            // hashmap checks).
            if (mergedRegion) {
              if (iters < 16) {
                mod._ppc_worker_force_relink_all(0);
              } else {
                mod._ppc_worker_relink_region_if_due(0);
              }
            }
            // Publish SAB diag so page can observe progress.
            Atomics.store(i32, PH4_DIAG_ITERS >> 2, iters | 0);
            Atomics.store(i32, PH4_DIAG_PC >> 2, pc | 0);
            Atomics.store(i32, PH4_DIAG_DC >> 2,
              i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2] | 0);
            Atomics.store(i32, PH4_DIAG_EXC >> 2,
              u32[(PPC_STATE_BASE + OFFSET_EXC) >> 2] | 0);
            // Call into C — owns the inner dispatch loop. Writes
            // ExitInfo into SAB at EXIT_ITERS_ADDR / EXIT_REASON_ADDR.
            // wall_deadline_ms / flags reserved (0).
            mod._ppc_worker_run_slice(C_SLICE_CAP, 0, 0);
            const sliceIters  = u32[EXIT_ITERS_ADDR  >> 2] >>> 0;
            const sliceReason = u32[EXIT_REASON_ADDR >> 2] >>> 0;
            iters += sliceIters;
            sliceCyclesBurned += sliceIters;
            // Refresh local pc cursor from SAB (C wrote it back).
            pc = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
            // Drive periodic CT pure-events drain — same cadence as
            // the legacy loop (every CT_FIRE_EVERY iters).
            if (sliceIters > 0) {
              const gtl = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
              const gth = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
              mod._ppc_worker_ct_fire_due_pure(gtl, gth);
            }
            // Dispatch on exit reason.
            switch (sliceReason) {
              case REASON_DOWNCOUNT:
                exitReason = 'downcount-exhausted';
                exitedSlice = true;
                break;
              case REASON_STOP_FLAG:
                exitReason = 'stop-flag';
                exitedSlice = true;
                break;
              case REASON_EXCEPTION: {
                // Mirror the legacy gating: deliver only when EE is on
                // for external-only interrupts (otherwise we'd thrash).
                const exc = u32[(PPC_STATE_BASE + OFFSET_EXC) >> 2] >>> 0;
                const msr = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
                const EXC_EXTERNAL_INT = 0x00000004;
                const EXC_DECREMENTER  = 0x00000001;
                // [ee-gate fix 2026-07-02] BOTH EXTERNAL_INT and DECREMENTER are EE-maskable — match the
                // sibling gate at ~line 1187 (fixed 2026-06-28). The old mask counted only EXTERNAL, so a
                // pending DEC made exc=0x5 (EXT+DEC) look non-maskable -> delivered at EE=0 -> guest spins
                // at 0x801138c4 instead of advancing to OSRestoreInterrupts + the idle spin 0x800ba2f0, so
                // the atomic handover can't catch it. Deferring maskable at EE=0 lets it advance.
                const EXC_MASKABLE = EXC_EXTERNAL_INT | EXC_DECREMENTER;
                const MSR_EE = 0x8000;
                const externalOnly = (exc & ~EXC_MASKABLE) === 0;
                if (!externalOnly || (msr & MSR_EE) !== 0) {
                  // [dual-core DSP/AI mask 2026-06-29] The worker now dispatches the interrupt
                  // itself again (fast path) — the DSP/AI overrun root is fixed in dolphin
                  // (ProcessorInterface::UpdateException + dolphin_read32 hide INT_CAUSE_DSP/AI),
                  // so __OSDispatchInterrupt only sees handleable interrupts (VI etc.) and the
                  // unbounded prio loop no longer overruns. Vector + re-enter.
                  _mboxCall10(pc >>> 0);
                  pc = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
                } else {
                  // EE off + external-only: dolphin will hold the
                  // interrupt until EE comes on. Exit the slice so
                  // dolphin's service_iter can update state.
                  exitReason = 'exception-pending';
                  exitedSlice = true;
                }
                break;
              }
              case REASON_REGION_MISS: {
                if (!compileOnMiss) {
                  exitReason = 'unmapped';
                  exitedSlice = true;
                  break;
                }
                const bytesSize = mod._ppc_worker_compile_and_accumulate(pc) >>> 0;
                if (bytesSize > 0) {
                  ++compileCalls;
                  totalCompileBytes += bytesSize;
                }
                // Force-relink in early warmup so the first miss-storm
                // doesn't sit compiling for 64 iters before a module
                // materializes. Matches the legacy path's policy.
                if (iters < 16 && bytesSize > 0) {
                  mod._ppc_worker_force_relink_all(0);
                } else {
                  mod._ppc_worker_relink_region_if_due(0);
                }
                // pc unchanged; re-enter slice — next dispatch retries.
                break;
              }
              case REASON_SAFETY_CAP:
                // Hit the C-side 1M ceiling — just re-enter. iters
                // bookkeeping above already accumulated.
                break;
              default:
                exitReason = 'unknown-c-exit-reason: ' + sliceReason;
                exitedSlice = true;
                break;
            }
            // Wall-time cap (perf-measurement mode).
            if (wallTimeMs > 0) {
              const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
              if ((now - wallStart) >= wallTimeMs) {
                exitReason = 'wall-time-cap';
                exitedSlice = true;
              }
            }
            // Phase IV slice cycles budget.
            if (sliceCyclesCap > 0 && sliceCyclesBurned >= sliceCyclesCap) {
              exitReason = 'slice-budget';
              exitedSlice = true;
            }
          }
          // Skip the legacy for-loop below; jump straight to the
          // post-loop commit + ack via a sentinel that mimics natural
          // loop exit. The if/for split makes that awkward, so we use
          // a labelled break would be cleaner — but for surgical
          // minimality we just guard the for-loop with a flag.
        }
        // Legacy JS inner loop (default path). Skipped when the C-slice
        // path above ran to completion.
        // [slice-active 2026-07-10 — PERMANENT, the mid-block delivery invariant] SAB
        // 0x026B1A00 = 1 while a worker slice executes (including parked-in-round-trip time).
        // Dolphin's autonomous delivery defers on it: an interrupted block must resume at the
        // interrupted instruction or defer the interrupt to a boundary — NEVER rewind to a
        // lagging set_pc (the HI-re-exec / duplicate-LO / torn-transfer class). Deliveries
        // reach the guest only via the worker's own loop-top or cmd-10.
        Atomics.store(i32, 0x026B1A00 >> 2, 1);
        // [cfg-provenance 2026-07-09 — PERMANENT] record WHICH loop is live (bit2=legacy,
        // bit0=C-slice) + a liveness counter, so acceptance runs verify against the actual
        // configuration, not the ledger's intent (the dead-C-slice false-"done" class).
        if (!(mod && mod.PPC_WORKER_USE_C_SLICE === 1)) {
          u32[0x026B1840 >> 2] = (u32[0x026B1840 >> 2] | 4) >>> 0;
          u32[0x026B1848 >> 2] = ((u32[0x026B1848 >> 2] >>> 0) + 1) >>> 0;
        } else {
          u32[0x026B1840 >> 2] = (u32[0x026B1840 >> 2] | 1) >>> 0;
        }
        // [vec-edge — task-18 instrument STRIPPED 2026-07-09 per gate #8; ring was 0x026B1850-18B0]
        // [deliv-reconcile 2026-07-09 — task #18 ROOT FIX] Dolphin delivers worker-raised SYNC
        // exceptions (ISI/DSI from cmd-9 interp fetches) on ITS thread between worker dispatches
        // — the sync arms are not owner-gated. The JS cursor then goes STALE and "block return
        // is canonical" dispatches OVER the redirect (proven: vec-disp 594(400)@1000>594 — the
        // rfi block re-ran with the ISI's SRR0/SRR1, clobbering the delivery and birthing the
        // self-sustaining 0x594@IR=1 ISI loop). Every dolphin delivery commit bumps the deliv-
        // ring head (SAB 0x026B0970, EXT + sync arms). Adopt ctx.PC as the cursor whenever the
        // generation moved since our last look. (Worker-inline deliveries move the cursor
        // themselves; cmd-10 re-reads ctx.PC — both already coherent.)
        // [pollAdvance 2026-07-09 — unified EE=0 completion-wait handler, ALL engagement sites]
        // Census (28 rolls): 21 wedged in DSP/EXI polls with sim-time at ~30k ticks/s — the
        // smooth-step never engaged (mailbox-bound polls never exhaust downcount; the sleep-tick
        // threshold of 1024 same-pc iters = 68s at 15Hz) and the old jumps targeted ONLY the
        // worker's PURE queue and never woke dolphin (the completing DSP/EXI events are HYBRIDS
        // in DOLPHIN's queue, head published @0x026B0910/14/18). This helper:
        //   - discriminates by the polled register (env read wrappers record addr+seq):
        //     fresh non-VI MMIO read => JUMP to min(pure head, dolphin head), LANDING ON the
        //     target (due now) + cmd-4 kick so dolphin's Advance fires the hybrid immediately;
        //     VI-range (0x0C002xxx beam) or no fresh MMIO (mftb/RAM polls) => smooth +2000;
        //   - caps jumps at 4 per same-pc episode (the H2 one-event lesson: uncapped jumping
        //     stormed 7k events/s -> exception burst -> PPCHalt on rolls 3/4) then smooths.
        // Returns true when it advanced time (caller refills downcount and continues).
        const pollAdvance = (pcNow) => {
          const msrP = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
          if ((msrP & 0x8000) !== 0) return false;                 // EE=1: event delivery wakes it
          if ((self.__pjPc >>> 0) !== (pcNow >>> 0)) { self.__pjPc = pcNow >>> 0; self.__pjN = 0; self.__pjCall = 0; }
          self.__pjCall = (self.__pjCall | 0) + 1;
          const lrs = (self.__lastMmioRdSeq | 0);
          const fresh = lrs !== (self.__pollSeqSeen | 0);
          self.__pollSeqSeen = lrs;
          const lra = (self.__lastMmioRdAddr >>> 0) & 0x0FFFFF00;
          // [periodic-event waits 2026-07-09] a hard 4-jump cap strangled waits fed by PERIODIC
          // events (the AX ucode pushes its response mail from the 1-ms DSP_Update tick — the
          // guest needs DOZENS of events, observed: 53 jumps then smooth-crawl forever at the
          // DSPCheckMailFromDSP face). After the first 4 burst jumps, keep jumping at a BOUNDED
          // rate (1 per 64 pollAdvance calls ~ few hundred events/s max — under storm levels).
          const jumpOk = ((self.__pjN | 0) < 4) || ((self.__pjCall & 63) === 0);
          if (fresh && lra !== 0x0C002000 && jumpOk) {
            let tl = 0, th = 0, have = false;
            const nx = findNextEventCycles();
            if (nx) { tl = nx.lo >>> 0; th = nx.hi >>> 0; have = true; }
            if (u32[0x026B0918 >> 2] !== 0) {
              const dl = u32[0x026B0910 >> 2] >>> 0, dh = u32[0x026B0914 >> 2] >>> 0;
              if (!have || (dh >>> 0) < (th >>> 0) || (dh === th && (dl >>> 0) < (tl >>> 0))) {
                tl = dl; th = dh; have = true;
              }
            }
            if (have) {
              const gl = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
              const gh = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
              const far = ((th >>> 0) > gh) || (th === gh && ((tl - gl) >>> 0) > 1024);
              if (far) {
                u32[(CT_BASE + CT_OFF_GTL) >> 2] = tl;             // land ON the target: due NOW
                u32[(CT_BASE + CT_OFF_GTH) >> 2] = th;
                mod._ppc_worker_ct_fire_due_pure(tl, th);
                mod._ppc_worker_mailbox_call_sync(4, 0x80000000);  // dolphin Advance fires hybrids NOW
                self.__pjN = (self.__pjN | 0) + 1;
                u32[0x026C0030 >> 2] = (self.__pollJumpN = (self.__pollJumpN | 0) + 1) >>> 0;
                lastPc = pcNow;
                Atomics.store(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, 20000);
                return true;
              }
            }
          }
          // beam / no-fresh-MMIO / jump-capped: smooth step + due-kick (the 2026-07-07 semantics)
          const gtl1 = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
          const step = (gtl1 + 2000) >>> 0;
          u32[(CT_BASE + CT_OFF_GTL) >> 2] = step;
          if (step < gtl1) u32[(CT_BASE + CT_OFF_GTH) >> 2] =
            ((u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0) + 1) >>> 0;
          mod._ppc_worker_ct_fire_due_pure(step, u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0);
          u32[0x026B0E48 >> 2] = (self.__smoothN = (self.__smoothN | 0) + 1) >>> 0;
          if (u32[0x026B0918 >> 2] !== 0) {
            const nl = u32[0x026B0910 >> 2] >>> 0, nh = u32[0x026B0914 >> 2] >>> 0;
            const g2 = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
            if (g2 > nh || (g2 === nh && step >= nl))
              mod._ppc_worker_mailbox_call_sync(4, 0x80000000);
          } else if ((self.__smoothN & 63) === 0)
            mod._ppc_worker_mailbox_call_sync(4, 0x80000000);
          lastPc = pcNow;
          Atomics.store(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, 20000);
          return true;
        };
        let __lastDelivGen = u32[0x026B0970 >> 2] >>> 0;
        // [ext-inflight guard 2026-07-16 — SUSTAIN: kill the ARAM/DSP interrupt storm]
        // Native delivers ONE external interrupt at a block boundary, runs its handler to
        // completion at EE=0 (the 0x500 vector clears MSR.EE; __OSDispatchInterrupt keeps
        // scheduler disabled), ACKs the device register, then rfi's back to the interrupted
        // pc (SRR0). It does NOT deliver the next EXT until that rfi lands. Our worker's
        // inline vectoring re-fired 0x500 on the very NEXT dispatch iteration whenever
        // EXTERNAL_INT was pending with EE=1 — so once the MP4 audio path parks in
        // aramStoreData's `while (HuARDMACheck())` spin (arqCnt, decremented ONLY by the
        // ARAM-DMA-complete ISR callback ArqCallBackAM), each ARAM completion (scheduled by
        // Do_ARAM_DMA every (count/32)*246 ticks, DSP.cpp) re-raised the DSP cause before the
        // guest's rfi + poll could observe arqCnt==0. The re-entry re-saved GPRs into the
        // handler's on-stack exceptionContext (OSCurrentContext is swapped by __ARHandler),
        // corrupted r1/the resume image, and the guest derailed (null-deref at __start). The
        // storm is exactly the one documented at DSP.cpp:476-479. Fix: track the SRR0 of the
        // in-flight delivery and REFUSE to vector another EXT until the guest's live pc returns
        // to it (rfi landed = handler finished = device ACKed). The pending EXT bit is left set
        // (deferred, not dropped) and re-attempts on a later iteration once the handler resumes.
        let __extInFlight = false;   // an EXT 0x500 vector is in progress; block re-delivery
        let __extSrr0 = 0;           // interrupted pc we vectored from (rfi must return here)
        let __extInflightIters = 0;  // safety: force-clear if the handler never returns to SRR0
        const __delivReconcile = () => {
          const _g = u32[0x026B0970 >> 2] >>> 0;
          if (_g !== __lastDelivGen) {
            __lastDelivGen = _g;
            const _live = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
            if (_live !== (pc >>> 0)) {
              u32[0x026B1904 >> 2] = ((u32[0x026B1904 >> 2] >>> 0) + 1) >>> 0;  // reconcile count
              pc = _live;
            }
            return true;
          }
          return false;
        };
        for (; (!(mod && mod.PPC_WORKER_USE_C_SLICE === 1
                  && typeof mod._ppc_worker_run_slice === 'function'))
               && iters < safetyCap; ++iters) {
          // [deliv-reconcile] adopt any dolphin-delivered redirect BEFORE dispatching (the
          // stale-cursor race, task #18 root — see the helper above).
          __delivReconcile();
          // [livepc-diag 2026-07-16 TEMP] Where is the guest ACTUALLY spinning while EXT
          // deliveries freeze? Publish live pc/msr @0x026B2728/272C and a tiny top-8 histogram
          // of the live pc @0x026B2730..0x026B276F (8 slots of {pc,count}). Gated cpu_owner==1.
          if (Atomics.load(i32, 0x026A0000 >> 2) === 1) {
            const _lpc = pc >>> 0;
            const _lmsr = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
            u32[0x026B2728 >> 2] = _lpc;
            u32[0x026B272C >> 2] = _lmsr;
            u32[0x026B2778 >> 2] = __extInFlight ? 1 : 0;   // is guard set right now
            u32[0x026B277C >> 2] = __extInflightIters >>> 0; // how deep in the safety cap
            // histogram: 8 slots at 0x026B2730 (pc) / 0x026B2734 (count), stride 8
            let _slot = -1, _free = -1;
            for (let k = 0; k < 8; k++) {
              const sp = 0x026B2730 + k * 8;
              const spc = u32[sp >> 2] >>> 0;
              if (spc === _lpc) { _slot = k; break; }
              if (_free < 0 && spc === 0 && (u32[(sp + 4) >> 2] >>> 0) === 0) _free = k;
            }
            if (_slot < 0 && _free >= 0) { _slot = _free; u32[(0x026B2730 + _free * 8) >> 2] = _lpc; }
            if (_slot >= 0) {
              const cp = (0x026B2730 + _slot * 8 + 4) >> 2;
              u32[cp] = ((u32[cp] >>> 0) + 1) >>> 0;
            }
          }
          // [ext-inflight guard FIX 2026-07-17 — DEVICE-SIDE "serviced" signal kills the 0x500 storm]
          // The old clear fired on the MSR.EE 0->1 edge, but MP4's ARQ ISR chain calls
          // OSRestoreInterrupts MID-handler (the AR-DMA callback re-enables interrupts to issue the
          // NEXT queued DMA) — dolsdk arq.c / OSInterrupt.c:476-480 — flipping EE to 1 BEFORE __ARHandler
          // acks INT_ARAM. Clearing the guard there let the still-asserted INT_CAUSE_DSP re-fire pc=0x500
          // ~1000x per service (96030 samples @0x500 / 91 acks), starving the idle fast-forward so the
          // trailing ARAM completions never fired and the ARQ queue byte (0x801D0539) never drained ->
          // gc frozen 198 (native drains pend->0, gc->214). The robust "this delivery is SERVICED" signal
          // is DEVICE-SIDE and flicker-free: INT_CAUSE_DSP (0x40) in the PI-cause mirror @0x026B27D0
          // (ProcessorInterface::UpdateException RELEASE-store = m_interrupt_cause) stays set until the
          // guest's __ARHandler ACKs ARAM (DSP_CONTROL write clears INT_ARAM -> UpdateInterrupts ->
          // SetInterrupt(INT_CAUSE_DSP,false)). Hold the one-at-a-time guard until that bit clears (or the
          // guest rfi'd back to the interrupted pc, or the safety cap). Survives the mid-ISR EE toggles
          // and __OSReschedule thread switch; matches native's one-delivery-per-completion cadence. For a
          // non-DSP EXT (VI etc.) the DSP bit is already 0 so it clears immediately — no over-hold.
          if (__extInFlight) {
            const _piDsp = (u32[0x026B27D0 >> 2] >>> 0) & 0x40;   // INT_CAUSE_DSP still pending device-side?
            if (_piDsp === 0 || (pc >>> 0) === (__extSrr0 >>> 0)
                || ++__extInflightIters > 200000) {
              __extInFlight = false;
              __extInflightIters = 0;
            }
          }
          // [pe-finish handler-run counter TEMP 2026-07-11] does the guest run
          // GXFinishInterruptHandler (0x800CAB3C, sets DrawDone=1 + wakes FinishQueue)
          // post-takeover? @0x026B1A98. If 0 -> PE_FINISH never dispatched to the guest.
          if ((pc >>> 0) === 0x800cab3c) u32[0x026B1A98 >> 2] = ((u32[0x026B1A98 >> 2] >>> 0) + 1) >>> 0;
          // [wall-2 TEMP] does the render thread execute GXSetDrawDone(0x800ca7a8)/the WPAR-token
          // block(0x800ca594)/GXWaitDrawDone(0x800ca840) post-takeover? gxSetDD@0x026B1A9C,
          // gxFlushTok@0x026B1AA0, gxWaitDD@0x026B1AA4. If all 0 -> render thread never runs the
          // draw-done path (stuck/asleep elsewhere), DrawDone=0 is stale from dolphin.
          if ((pc >>> 0) === 0x800ca7a8) u32[0x026B1A9C >> 2] = ((u32[0x026B1A9C >> 2] >>> 0) + 1) >>> 0;
          if ((pc >>> 0) === 0x800ca594) u32[0x026B1AA0 >> 2] = ((u32[0x026B1AA0 >> 2] >>> 0) + 1) >>> 0;
          if ((pc >>> 0) === 0x800ca840) u32[0x026B1AA4 >> 2] = ((u32[0x026B1AA4 >> 2] >>> 0) + 1) >>> 0;
          // [arq-diag 2026-07-16 TEMP] Does the ARAM-complete ISR chain reach the byte-decrement?
          // __ARQInterruptServiceRoutine@0x800c706c -> aramQueueCallback@0x8011145c (decrements the
          // aramQueueLo depth byte @0x801D0539 that aramSyncTransferQueue spins on). Also sample the
          // live spin byte itself. arqIsrN@0x026B27A4, aramCbN@0x026B27A8, spinByte@0x026B27AC.
          if ((pc >>> 0) === 0x800c706c) u32[0x026B27A4 >> 2] = ((u32[0x026B27A4 >> 2] >>> 0) + 1) >>> 0;
          if ((pc >>> 0) === 0x8011145c) u32[0x026B27A8 >> 2] = ((u32[0x026B27A8 >> 2] >>> 0) + 1) >>> 0;
          // [arq-diag2] which handler does __OSDispatchInterrupt route to? __OSDispatchInterrupt
          // @0x800b7714, __DSPHandler@0x800c7558, __ARHandler@0x800c65dc, __ARChecksTdmaOverflow via
          // __AICallback. dispN@0x026B27B0, dspHN@0x026B27B4, arHN@0x026B27B8.
          if ((pc >>> 0) === 0x800b7714) u32[0x026B27B0 >> 2] = ((u32[0x026B27B0 >> 2] >>> 0) + 1) >>> 0;
          if ((pc >>> 0) === 0x800c7558) u32[0x026B27B4 >> 2] = ((u32[0x026B27B4 >> 2] >>> 0) + 1) >>> 0;
          if ((pc >>> 0) === 0x800c65dc) u32[0x026B27B8 >> 2] = ((u32[0x026B27B8 >> 2] >>> 0) + 1) >>> 0;
          if (mem1Base !== 0 && Atomics.load(i32, 0x026A0000 >> 2) === 1) {
            const _byteOff = (mem1Base + (0x801D0539 - 0x80000000)) >>> 0;   // wasm-heap byte addr
            const _alignedWord = u32[(_byteOff & ~3) >> 2] >>> 0;             // containing 32-bit word
            u32[0x026B27AC >> 2] = (_alignedWord >>> ((_byteOff & 3) * 8)) & 0xFF;  // extract the target byte (LE heap)
          }
          // [await-pc 2026-07-03] The boot dispatcher can start before dolphin publishes
          // the first real pc — the SAB slot is zero-initialized, and dispatching pc=0
          // walks the reset vector's stub, manufacturing 'Unhandled Exception 0' (guest
          // OSREPORT) that tramples the boot process state (the invisible scene-killer).
          // Gate ONLY the initial zero state; once any nonzero pc is seen, never re-gate
          // (mid-run vectors to low memory stay legal — the old blanket guard starved boot).
          if (!self.__pcEverValid) {
            if ((pc >>> 0) === 0) { exitReason = 'await-pc'; break; }
            self.__pcEverValid = true;
          }
          // [vec-trace 2026-07-07] one-shot: on the first vector-page dispatch
          // (pc<0x4000), record it + the next 16 dispatched pcs @0x026B0E50 (17 slots +
          // armed-flag at +0x44). Answers "does the stub chain execute after delivery".
          {
            const _vt = u32[0x026B0E94 >> 2] >>> 0;  // 0=idle, 1..17=recording, 18=done
            if (_vt === 0 && pc < 0x4000 && pc >= 0x100) {
              u32[0x026B0E50 >> 2] = pc >>> 0;
              u32[0x026B0E94 >> 2] = 1;
            } else if (_vt >= 1 && _vt < 17) {
              u32[(0x026B0E50 + (_vt << 2)) >> 2] = pc >>> 0;
              u32[0x026B0E94 >> 2] = _vt + 1;
            }
          }
          // [pc-ring — PERMANENT, cheap] last-256 dispatched pcs @SAB 0x026B0A40 (head
          // ctr @0x026B0E44, monotonic). One store per block-exit; the deliv-ring stamps
          // this counter at each delivery so post-mortems align dispatches to deliveries.
          {
            const _h = u32[0x026B0E44 >> 2] >>> 0;
            u32[(0x026B0A40 + ((_h & 255) << 2)) >> 2] = pc >>> 0;
            u32[0x026B0E44 >> 2] = _h + 1;
          }
          if ((((pc < 0x80000000) && (pc < 0x100 || pc > 0xfff)) || pc >= 0x81800000) && !self.__rawLogged) {
            // Skip the legit real-mode exception vectors (0x100..0xd00) so the ring
            // captures the HANDLER's execution (e.g. 0xc00 syscall handler) up to the
            // REAL garbage (0x840480), pinpointing where the handler diverges.
            self.__rawLogged = true;
            // [garbage-path] pc went out of guest range: the block dispatched at
            // the PRECEDING ring entry returned this bad next-pc. Dump the path so
            // we can disassemble that block + diff what value it read (the cutover
            // state bug) vs native. Also dump the diverging block's regs.
            postMessage({ cmd: 'print', txt: '[ppc-path] GARBAGE next=0x' + (pc >>> 0).toString(16)
              + ' r1=0x' + (u32[(PPC_STATE_BASE + 0x14 + 1*4) >> 2] >>> 0).toString(16)
              + ' r3=0x' + (u32[(PPC_STATE_BASE + 0x14 + 3*4) >> 2] >>> 0).toString(16)
              + ' r5=0x' + (u32[(PPC_STATE_BASE + 0x14 + 5*4) >> 2] >>> 0).toString(16)
              + ' srr0=0x' + (u32[(PPC_STATE_BASE + 0x340 + 26*4) >> 2] >>> 0).toString(16)
              + ' lr=0x' + (u32[(PPC_STATE_BASE + 0x340 + 8*4) >> 2] >>> 0).toString(16) });
          }
          // Update SAB diag every 256 iters so we can see progress
          // from the page even if no ack ever fires.
          if ((iters & 0xFF) === 0) {
            Atomics.store(i32, PH4_DIAG_ITERS >> 2, iters | 0);
            Atomics.store(i32, PH4_DIAG_PC >> 2, pc | 0);
            Atomics.store(i32, PH4_DIAG_DC >> 2,
              i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2] | 0);
            Atomics.store(i32, PH4_DIAG_EXC >> 2,
              u32[(PPC_STATE_BASE + OFFSET_EXC) >> 2] | 0);
          }
          // External stop flag (page or dolphin requesting yield).
          if (Atomics.load(i32, STOP_FLAG_ADDR >> 2) !== 0) {
            exitReason = 'stop-flag'; break;
          }
          // [collapse] AUTHORITATIVE CPU OWNERSHIP. If the WORKER does not own the CPU, dispatch ZERO guest
          // blocks. This clean boundary has pc/downcount/exc already flushed to SAB with no block in flight.
          // cpu_owner @ SAB 0x026A0000: 0=DOLPHIN (boot default), 1=WORKER. Task 1 first cut: yield the slice
          // when not owner; Task 2 replaces the break with Atomics.wait to park until ownership is re-granted.
          if (Atomics.load(i32, 0x026A0000 >> 2) !== 1) {
            exitReason = 'not-owner'; break;
          }
          // Phase IV slice cycles budget exhausted — yield to dolphin
          // service_iter so MMIO mirror drains and hybrid-event cadence
          // gets applied to CoreTiming.
          // [owner-no-yield 2026-07-07] Every purpose of this yield is superseded under
          // worker ownership: the mailbox drain is unconditional in run_iter_batch
          // (fix 1), the due-kick fires dolphin synchronously at event-due points, and
          // the mmio-mirror is disabled. The exit only cost a full page round-trip PER
          // SLICE — measured ackIters=1/slice at the spin ≈ one block per ~1ms+latency,
          // the pace root in its purest form. The wall-time-cap above still bounds the
          // slice, so the page keeps getting acks.
          if (sliceCyclesCap > 0 && sliceCyclesBurned >= sliceCyclesCap
              && Atomics.load(i32, 0x026A0000 >> 2) !== 1) {
            exitReason = 'slice-budget'; break;
          }
          // Wall-time gated CT fire (was dispatch-count gated on
          // `iters & (CT_FIRE_EVERY - 1)`). See declaration of
          // lastCtFireMs above for why. Cheap check on every iter via
          // performance.now() — V8 inlines it. The 16ms interval
          // matches native VI cadence (60 Hz) regardless of dispatch
          // throughput, so events scheduled to fire at wall-60Hz
          // actually fire at wall-60Hz rather than at JIT-disp-rate/256.
          if ((sliceCyclesBurned - lastCtFireCycles) >= CT_FIRE_CYCLES) {
            lastCtFireCycles = sliceCyclesBurned;
            // Phase 2e fix: advance global_timer by the cycles burned
            // since the last CT-fire, THEN fire_due_pure with the new
            // time. Without this advance, events scheduled mid-slice
            // never become due during the slice — fire_due_pure reads
            // a stale global_timer that only updates at slice end.
            const deltaCycles = (sliceCyclesBurned - cyclesAdvancedSoFar) >>> 0;
            if (deltaCycles > 0 && typeof mod._ppc_worker_advance_global_timer === 'function') {
              const gtl0 = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
              const gth0 = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
              const sumLo = (gtl0 + deltaCycles) >>> 0;
              const carry = (sumLo < gtl0) ? 1 : 0;
              const sumHi = (gth0 + carry) >>> 0;
              mod._ppc_worker_advance_global_timer(sumLo, sumHi);
              cyclesAdvancedSoFar = sliceCyclesBurned;
              mod._ppc_worker_ct_fire_due_pure(sumLo, sumHi);
            } else {
              // No new cycles burned (mostly waste). Still poll for
              // already-due events (cheap).
              const gtl = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
              const gth = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
              mod._ppc_worker_ct_fire_due_pure(gtl, gth);
            }
          }
          // [ext-reassert 2026-07-16 — DELIVERY-RATE FIX for the MP4 audio-init wedge]
          // Root cause (verified via live-pc histogram + gate telemetry): during MP4's
          // aramStoreData queue-full wait (a tight OSDisableInterrupts/OSRestoreInterrupts
          // EE-toggle spin) the guest reaches EE=1 thousands of times, but EXTERNAL_INT is
          // NOT set in ppc_state.Exceptions at those moments — so the vectoring gate below
          // never fires. WHY: our inline vector CLEARS EXTERNAL_INT (line ~1577); dolphin's
          // ProcessorInterface::UpdateException is the ONLY thing that RE-asserts it, and it
          // runs on the DEVICE worker only when kicked (mailbox cmd-4 / CoreTiming::Advance).
          // pollAdvance kicks dolphin only while EE=0 (line 1253 early-returns on EE=1), so the
          // EE=1 windows see a STALE-cleared EXTERNAL_INT. AID/ARAM stay asserted at the PI
          // level (dspToExt climbs to ~22k) but never reach the guest -> gExtEe froze at 131
          // and globalCounter stuck at 156. FIX: when the CPU worker owns the CPU, the guest is
          // at EE=1, and EXTERNAL_INT is NOT currently set, kick dolphin (cmd-4) so its
          // Advance()->UpdateException re-commits any PI-asserted device IRQ into Exceptions,
          // then re-read exc so the SAME iteration's gate below vectors it. Rate-limited to a
          // WAIT-LOOP spin so hot forward-progress code pays nothing. The aramStoreData toggle
          // is a MULTI-pc ping-pong (0x80111a48<->0x80111bb4) that never accumulates samePcCount
          // (see the loop-window note below) — so gate on EITHER same-pc (single-pc spin) OR the
          // multi-pc loop-window counter self.__lwN. The kick is the identical cmd-4 pollAdvance
          // already issues at EE=0.
          if (!ignoreDowncount && Atomics.load(i32, 0x026A0000 >> 2) === 1) {
            const _msrEE = (u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0) & 0x8000;
            const _excNow = u32[(PPC_STATE_BASE + OFFSET_EXC) >> 2] >>> 0;
            if (_msrEE !== 0 && (_excNow & 0x00000004) === 0
                && !__extInFlight && (((samePcCount | 0) >= 2) || ((self.__lwN | 0) >= 2))
                && ((self.__reassertN = (self.__reassertN | 0) + 1) & 3) === 0) {
              // dolphin Advance fires due AID/ARAM CoreTiming events + re-runs
              // ProcessorInterface::UpdateException, re-committing EXTERNAL_INT if a device
              // IRQ is asserted at the PI level. Re-read exc below picks it up this iteration.
              // [vi-dsp-prio A/B 2026-07-16] DISABLED: reassertN=2929 fires storm the guest at the
              // 0x500 EXT vector (pcHist 500:21104), starving __OSDispatchInterrupt (dispN~0) — the
              // reassert is redundant once VI-hide (dolphin_read32) lets DSP_ARAM through the prio walk.
              // mod._ppc_worker_mailbox_call_sync(4, 0x80000000);
              u32[0x026B279C >> 2] = ((u32[0x026B279C >> 2] >>> 0) + 1) >>> 0;  // reassert-kick count (probe)
            }
          }
          // Exception pending? Deliver via dolphin_check_exc (mailbox cmd 10),
          // then re-read PC from SAB and continue dispatching from the vector.
          // Under Phase IV, exiting the slice would deadlock — dolphin's
          // service_iter can't dispatch PPC, so nobody else delivers.
          if (!ignoreDowncount) {
            const exc = u32[(PPC_STATE_BASE + OFFSET_EXC) >> 2] >>> 0;
            if (exc !== 0) {
              const msr = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
              const EXC_EXTERNAL_INT = 0x00000004;
              const EXC_DECREMENTER  = 0x00000001;
              // [maskable-set fix 2026-06-28] BOTH EXTERNAL_INT and DECREMENTER are
              // EE-maskable async interrupts (PowerPC.cpp CheckExternalExceptions gates
              // both on MSR.EE). The old code masked only EXTERNAL_INT, so a pending DEC
              // (exc=0x5 at the SelectThread idle loop) looked "non-maskable" -> the worker
              // issued cmd-10 every iter, dolphin couldn't vector at EE=0, and it spun
              // forever (safety-cap) WITHOUT advancing the guest to its OSRestoreInterrupts.
              const EXC_MASKABLE = EXC_EXTERNAL_INT | EXC_DECREMENTER;
              const MSR_EE = 0x8000;
              const externalOnly = (exc & ~EXC_MASKABLE) === 0;
              if (!externalOnly || (msr & MSR_EE) !== 0) {
                // [npc-sync fix 2026-06-28] CheckExternalExceptions captures
                // SRR0 = ppc_state.npc (PowerPC.cpp:603/627). The worker maintains
                // PC on dispatch but NOT NPC, so at a non-mtmsr block (e.g. the
                // SelectThread idle spin 0x800ba2f0 = lwz/cmplwi/beq) NPC stays
                // STALE at dolphin's last pre-cutover block (observed SRR0 =
                // ReverbHICallback+0x54). Delivery then sets SRR0 = garbage, and
                // the handler's rfi returns to the wrong context (EE=0) instead of
                // the spin -> guest wedges at EE=0, never wakes. Native takes the
                // async int at the block boundary with SRR0 = the about-to-run pc
                // (native trace: DEC vector srr0=0x800ba2f0). Mirror that: NPC = pc.
                u32[(PPC_STATE_BASE + OFFSET_NPC) >> 2] = pc >>> 0;
                // [STEP 2 REDO 2026-07-09 — worker-side EXT vectoring ON THE LIVE LOOP] The prior
                // step-2 implementation sat in the dead C-slice (PPC_WORKER_USE_C_SLICE=0); THIS
                // is the live dispatch loop, so the inline delivery lives here. Post-takeover
                // (cpu_owner==1) the CPU worker vectors the async EXTERNAL_INT itself — no cmd-10
                // round-trip — reproducing CheckExternalExceptions' commit exactly (PowerPC.cpp):
                // SRR0=pc (npc-synced above), SRR1=msr&0x87C0FFFF, MSR.LE=ILE, msr&=~0x04EF36,
                // msr|=0x1000 (ME-preserve), pc=0x500. Gates: EE=1 (checked in the enclosing if,
                // re-checked here for the EXT bit specifically), pc>=0x4000 (never vector inside a
                // stub), os-ready (MEM[0xC0] = valid physical OSCurrentContext), owner==1 (pre-
                // takeover boot keeps cmd-10 byte-identical — protects gm40/gm50 determinism).
                // The EXC clear is Atomics.and so a concurrent device-worker set (Processor-
                // Interface UpdateException, __atomic RELEASE) can't be lost (deferral != drop).
                // DEC/sync exceptions still route via cmd-10 below. Deferred bits re-attempt
                // loop-natively (this block re-runs every dispatch iteration).
                // [gate-diag 2026-07-16 TEMP] why does EXT vectoring freeze while the idle loop
                // reaches EE=1? Count gate outcomes @0x026B2780..0x026B279F (cpu_owner==1 only).
                if (Atomics.load(i32, 0x026A0000 >> 2) === 1) {
                  const _hasExt = (exc & EXC_EXTERNAL_INT) !== 0;
                  const _eeOn = (msr & MSR_EE) !== 0;
                  if (_hasExt) u32[0x026B2780 >> 2] = ((u32[0x026B2780 >> 2] >>> 0) + 1) >>> 0;         // EXT pending seen
                  if (_hasExt && _eeOn) u32[0x026B2784 >> 2] = ((u32[0x026B2784 >> 2] >>> 0) + 1) >>> 0; // EXT+EE=1
                  if (_hasExt && _eeOn && !__extInFlight) u32[0x026B2788 >> 2] = ((u32[0x026B2788 >> 2] >>> 0) + 1) >>> 0; // +guard clear
                  if (_hasExt && _eeOn && !__extInFlight && (pc >>> 0) >= 0x4000 && mem1Base !== 0) {
                    const _c0 = u32[(mem1Base + 0xC0) >> 2] >>> 0;
                    const _oc = (((_c0 & 0xFF) << 24) | ((_c0 & 0xFF00) << 8) | ((_c0 >>> 8) & 0xFF00) | (_c0 >>> 24)) >>> 0;
                    u32[0x026B278C >> 2] = _oc;  // last osCtx value seen at a would-be vector
                    if (_oc !== 0 && _oc < 0x01800000) u32[0x026B2790 >> 2] = ((u32[0x026B2790 >> 2] >>> 0) + 1) >>> 0; // osCtx OK
                    else u32[0x026B2794 >> 2] = ((u32[0x026B2794 >> 2] >>> 0) + 1) >>> 0; // osCtx REJECT
                  }
                }
                if ((exc & EXC_EXTERNAL_INT) !== 0 && (msr & MSR_EE) !== 0
                    && (pc >>> 0) >= 0x4000
                    && !__extInFlight   // [ext-inflight guard 2026-07-16] one EXT at a time (native parity)
                    && Atomics.load(i32, 0x026A0000 >> 2) === 1
                    && mem1Base !== 0) {
                  const _rawC0 = u32[(mem1Base + 0xC0) >> 2] >>> 0;
                  const _osCtx = (((_rawC0 & 0xFF) << 24) | ((_rawC0 & 0xFF00) << 8)
                                  | ((_rawC0 >>> 8) & 0xFF00) | (_rawC0 >>> 24)) >>> 0;
                  if (_osCtx !== 0 && _osCtx < 0x01800000) {
                    u32[(PPC_STATE_BASE + 0x3A8) >> 2] = pc >>> 0;            // SRR0 = interrupted pc
                    const _srr1 = (msr & 0x87C0FFFF) >>> 0;
                    u32[(PPC_STATE_BASE + 0x3AC) >> 2] = _srr1;               // SRR1 = masked msr image
                    let _nmsr = ((msr & ~1) | ((msr >>> 16) & 1)) >>> 0;      // LE(bit0) = ILE(bit16)
                    _nmsr = (_nmsr & ~0x04EF36) >>> 0;                        // clear EE/IR/DR/... (dolphin parity)
                    _nmsr = (_nmsr | 0x1000) >>> 0;                           // ME-preserve
                    Atomics.store(i32, (PPC_STATE_BASE + OFFSET_MSR) >> 2, _nmsr | 0);
                    Atomics.and(i32, (PPC_STATE_BASE + OFFSET_EXC) >> 2, ~EXC_EXTERNAL_INT);
                    // [dSrr0 side-channel — STEP-2 acceptance, FRESH cells (0x0600 is AoT-pack-
                    // polluted per audit wf_fa7314c9)]: 0x026B0630=SRR0, 0x0634=SRR1 image
                    // (identity: v&0x87C0FFFF==v AND bit 0x8000 set), 0x0638=delivery count.
                    u32[0x026B0630 >> 2] = pc >>> 0;
                    u32[0x026B0634 >> 2] = _srr1;
                    u32[0x026B0638 >> 2] = ((u32[0x026B0638 >> 2] >>> 0) + 1) >>> 0;
                    // [ext-inflight guard 2026-07-16] Mark this delivery in-flight and remember
                    // the interrupted pc (== SRR0). The loop-head clears the guard once the
                    // guest's ISR chain rfi's back here, gating the next EXT until then (native
                    // one-at-a-time delivery; ends the ARAM/DSP re-entry storm).
                    __extInFlight = true;
                    __extSrr0 = pc >>> 0;
                    __extInflightIters = 0;
                    u32[0x026B063C >> 2] = pc >>> 0;  // [ext-inflight] published SRR0 for probe
                    pc = 0x500;
                    u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] = pc;
                    u32[(PPC_STATE_BASE + OFFSET_NPC) >> 2] = pc;
                    continue;
                  }
                }
                // [ext-storm fix 2026-07-16 — serialize EXT via cmd-10 too] When an EXT is
                // already in flight (__extInFlight: a 0x500 vector delivered, its ISR running
                // at EE=0 and not yet rfi'd back), DO NOT deliver a second EXTERNAL_INT here.
                // The inline path above already honors __extInFlight; but the cmd-10 fall-
                // through did NOT — so when the inline gate was skipped BY the guard, cmd-10
                // (dolphin_check_exc) re-vectored 0x500 anyway, defeating one-at-a-time
                // serialization. That is the MP4 audio-init STORM: pcring/wring pinned at
                // 0x500 <-> 0x801116e0 (aramSyncTransferQueue), each ARAM completion re-raising
                // INT_ARAM and cmd-10 re-vectoring before the ARQ ISR chain (aramQueueCallback,
                // which decrements the aramQueueLo depth byte @0x801D0539) finishes — so the
                // spin byte never drains and globalCounter froze at 156. Defer the EXT (leave
                // the pending bit set) when the guard is up; it re-attempts once the ISR rfi's
                // (guard clears on the EE 0->1 edge at the loop head). NON-EXTERNAL exceptions
                // (DEC alone / sync) are NOT guarded and still route through cmd-10.
                if (__extInFlight && (exc & EXC_EXTERNAL_INT) !== 0
                    && (exc & ~EXC_EXTERNAL_INT & ~EXC_DECREMENTER) === 0
                    && Atomics.load(i32, 0x026A0000 >> 2) === 1) {
                  // Deferred: an EXT is in flight. Do NOT re-deliver — fall through to normal
                  // block dispatch so the guest keeps executing its CURRENT ISR (which, on rfi,
                  // clears the guard at the loop head, and the deferred EXT re-attempts then).
                  u32[0x026B27A0 >> 2] = ((u32[0x026B27A0 >> 2] >>> 0) + 1) >>> 0;  // cmd-10 EXT defers (probe)
                } else {
                  // mailbox cmd 10 (dolphin_check_exc) — call directly; the
                  // call1 helper is scoped to the env-setup block, not here.
                  self.__delivN = (self.__delivN | 0) + 1;  // [r31-trap] count deliveries
                  mod._ppc_worker_mailbox_call_sync(10, pc >>> 0) >>> 0;
                  pc = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
                  // [redirect-trace 2026-07-07] publish this loop's base + the re-read pc
                  // (SAB 0x026B0E98/0x026B0E9C) — the active-loop discriminator.
                  {
                    const _v = new Uint32Array(sharedMemoryRef.buffer);
                    _v[0x026B0E98 >> 2] = PPC_STATE_BASE >>> 0;
                    _v[0x026B0E9C >> 2] = pc >>> 0;
                  }
                  continue;
                }
              }
            }
            const downcount = i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2];
            if (downcount <= 0) {
              // [slice self-refill 2026-07-03] THE cadence wall: the worker burned its
              // 20000-cycle slice ~instantly and used to exit-and-wait for dolphin's tick
              // to refill — measured <2 slices/s (retired 3332404/90s ÷ 20000). Post-
              // handover the worker OWNS the CPU: refill locally and keep executing. The
              // per-iter CT-fire path advances the shared global timer + fires due pure
              // events as cycles accrue; dolphin's own tick keeps firing hybrid (VI/DSP)
              // events at its wall cadence from the published time. Pre-handover
              // (cpu_owner==0) keeps the old exit so boot-dispatch behavior is unchanged.
              if (Atomics.load(i32, 0x026A0000 >> 2) === 1) {
                // [idle-slice jump 2026-07-03] Chain mode burns a full 20000-cycle slice
                // in-wasm; a slice that returned at the SAME pc it entered = the guest is
                // wait-spinning (VIWaitForRetrace/ARQ). Jump sim-time to the next event NOW
                // instead of waiting ~100 idle slices for the legacy detector — frames were
                // gated at sim-cycles/8.1M (measured 285 frames vs 1.95B retired).
                if (pc === lastPc) {
                  // [smooth-poll 2026-07-07] EE=0 spin = a POLL of time-derived hardware
                  // (VI beam position: pcring caught 0x800c730c/7598/759c looping at
                  // msr=0x1032 exc=4 for 12K+ dispatches — the jump aliased the beam
                  // position past the poll's target window every sample). No event can
                  // wake an EE=0 poll; it exits only by OBSERVING the value sweep. Step
                  // time smoothly instead of jumping.
                  if (pollAdvance(pc)) {
                    self.__selfRefills = (self.__selfRefills | 0) + 1;
                    continue;
                  }
                  const nxt = findNextEventCycles();
                  if (nxt) {
                    const gtl0 = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
                    const gth0 = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
                    const farHi = (nxt.hi >>> 0) > (gth0 >>> 0);
                    const farLo = (nxt.hi === gth0) && ((nxt.lo - gtl0) >>> 0) > 1024;
                    if (farHi || farLo) {
                      let newLo = (nxt.lo - 1) >>> 0;
                      let newHi = nxt.hi >>> 0;
                      if (newLo === 0xFFFFFFFF && nxt.lo === 0) newHi = (newHi - 1) >>> 0;
                      u32[(CT_BASE + CT_OFF_GTL) >> 2] = newLo;
                      u32[(CT_BASE + CT_OFF_GTH) >> 2] = newHi;
                      mod._ppc_worker_ct_fire_due_pure(newLo, newHi);
                      self.__isjN = (self.__isjN | 0) + 1;
                      mod._ppc_worker_mailbox_call_sync(4, 0x80000000);  // wake dolphin: fire hybrids NOW
                    }
                  }
                }
                lastPc = pc;
                Atomics.store(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, 20000);
                self.__selfRefills = (self.__selfRefills | 0) + 1;
                continue;
              }
              exitReason = 'downcount-exhausted'; break;
            }
          }
          // Wall-time cap (perf-measurement mode).
          if (wallTimeMs > 0 && (iters & 0xfff) === 0) {
            const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            if ((now - wallStart) >= wallTimeMs) { exitReason = 'wall-time-cap'; break; }
          }
          // Phase 3a.4 fast-path: merged-region dispatch via C side.
          // Phase 3a.5: also a startup force-relink. On the very first
          // miss-storm (no module yet for the entry region) the natural
          // 64-block threshold means dispatch keeps missing until 64
          // accumulates. Forcing relink on iter==0 + after ANY accumulate
          // shrinks the warm-up window from seconds to milliseconds.
          // ppc_worker_region_dispatch_pc returns next-pc on hit, or
          // 0xFFFFFFFF on miss. C-side BlockCache::region_dispatch
          // does the pcMap lookup + regionFn() call inside one
          // EM_ASM_INT — far less per-iter overhead than the legacy
          // JS-side scan + per-block instance.exports lookup.
          if (mergedRegion) {
            const next = mod._ppc_worker_region_dispatch_pc(pc) >>> 0;
            if (next !== 0xFFFFFFFF) {
              // Hit. Update SAB pc + fall through to downcount/loop.
              if (!ignoreDowncount) {
                Atomics.sub(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, 1);
              }
              sliceCyclesBurned += 1;
              u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] = next;
              // Same-PC idle-skip detector applies to merged path too.
              if (next === lastPc) {
                ++samePcCount;
                // [pollAdvance engage 2026-07-09] mailbox-bound EE=0 polls run at ~15Hz — the
                // 1024-iter sleep-tick threshold = 68s (never engages in a roll). Engage the
                // unified poll handler FAST (>=8 same-pc, rate-limited every 8 iters).
                if (Atomics.load(i32, 0x026A0000 >> 2) === 1
                    && samePcCount >= 8 && (samePcCount & 7) === 0) {
                  if (pollAdvance(next)) { pc = next; continue; }
                }
                // Item 7 sleep-tick: aggressively bump SAB global_timer
                // when same-PC is sustained and next event is far. Runs
                // BEFORE the 100-iter idle-skip exit so we don't bounce
                // out into dolphin to drain a slice we could fast-skip.
                if (samePcCount >= SLEEP_TICK_THRESHOLD) {
                  const nxt = findNextEventCycles();
                  if (nxt) {
                    const gtl0 = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
                    const gth0 = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
                    // 64-bit subtract: nxt - cur. Treat as cycles diff;
                    // only ff if hi-words differ or lo distance > 1024.
                    const farHi = (nxt.hi >>> 0) > (gth0 >>> 0);
                    const farLo = (nxt.hi === gth0) && ((nxt.lo - gtl0) >>> 0) > 1024;
                    if (farHi || farLo) {
                      // Set SAB global_timer to (next - 1). Phase IV makes
                      // dolphin's Advance() adopt this value on next call.
                      let newLo = (nxt.lo - 1) >>> 0;
                      let newHi = nxt.hi >>> 0;
                      if (newLo === 0xFFFFFFFF && nxt.lo === 0) newHi = (newHi - 1) >>> 0;
                      u32[(CT_BASE + CT_OFF_GTL) >> 2] = newLo;
                      u32[(CT_BASE + CT_OFF_GTH) >> 2] = newHi;
                      // Fire any due pure-PPC events now.
                      mod._ppc_worker_ct_fire_due_pure(newLo, newHi);
                      if (++sleepTickCount <= 4) {
                        postMessage({ cmd: 'print',
                          txt: '[ppc-worker] sleep-tick #' + sleepTickCount
                             + ' pc=0x' + pc.toString(16)
                             + ' jumpTo=0x' + newHi.toString(16) + newLo.toString(16).padStart(8,'0') });
                      }
                      samePcCount = 0;
                    }
                  }
                }
                if (samePcCount > 100 && !disableIdleSkip) { exitReason = 'idle-skip'; break; }
              } else { samePcCount = 0; lastPc = next; }
              pc = next;
              continue;
            }
            // Miss → fall through to compile_and_accumulate.
            const bytesSize = mod._ppc_worker_compile_and_accumulate(pc) >>> 0;
            if (bytesSize > 0) {
              ++compileCalls;
              totalCompileBytes += bytesSize;
            }
            // Phase 3a.5 force-relink-on-warmup: the natural threshold
            // (≥64 blocks) means the very first miss-storm sits compiling
            // for 64 iters before the first module materializes. Force
            // relink for the first 16 iterations to shrink that to ~16
            // misses; afterwards rely on the natural threshold.
            if (iters < 16 && bytesSize > 0) {
              mod._ppc_worker_force_relink_all(0);
            } else if ((iters & relinkCheckMask) === 0) {
              mod._ppc_worker_relink_region_if_due(0);
            }
            // pc unchanged; next iter retries dispatch (on the same pc
            // if relink happened it'll hit, else continues compiling).
            continue;
          }
          // Legacy 2g per-block-instance path (unchanged).
          let region = null, idx = -1, blockCycles = 1;
          for (const k in regions) {
            const r = regions[k];
            if (r && r.pcMap && r.pcMap.has(pc)) {
              region = r; idx = r.pcMap.get(pc);
              if (r.cycleMap && r.cycleMap.has(pc)) blockCycles = r.cycleMap.get(pc) || 1;
              break;
            }
          }
          // [vec-check 2026-07-03] Vector-page blocks (pc<0x4000) are rewritten by
          // OSExceptionInit (dolsdk OS.c:282-284: memcpy + DCFlushRangeNoSync + sync +
          // ICInvalidateRange) — an icbi our cache can't see. Re-verify the first
          // instruction word each dispatch; mismatch = stale compile -> drop + recompile.
          if (region && (pc >>> 0) < 0x4000 && mem1Base && self.__vecWord) {
            // [vec-check FULL-BLOCK 2026-07-07] First-word-only verification let a stale
            // stub TAIL execute: the 0x500 block compiled from PARTIAL stub bytes (first
            // word already final), ran off the end to 0x594 -> guest ISI -> 'Non-recoverable
            // Exception 3' -> PPCHalt (the post-takeover crash). Record + verify a 32-word
            // window (the OS stub template is <= 0x80 bytes) — full staleness coverage at
            // delivery-rate cost only.
            const _base = (mem1Base + (pc & 0x01FFFFFF)) >> 2;
            let _rec = self.__vecWord.get(pc >>> 0);
            if (_rec === undefined) {
              _rec = new Uint32Array(40);
              for (let _w = 0; _w < 40; _w++) _rec[_w] = u32[_base + _w] >>> 0;
              self.__vecWord.set(pc >>> 0, _rec);
              if ((self.__vecRecN = (self.__vecRecN | 0) + 1) <= 8)
                postMessage({ cmd: 'print', txt: '[vec-rec] pc=0x' + pc.toString(16)
                  + ' mem1Base=0x' + (mem1Base >>> 0).toString(16)
                  + ' w0=0x' + (_rec[0] >>> 0).toString(16) });
            } else {
              let _stale = -1;
              for (let _w = 0; _w < 40; _w++) {
                if (_rec[_w] !== (u32[_base + _w] >>> 0)) { _stale = _w; break; }
              }
              if (_stale >= 0) {
                const _oldW = _rec[_stale] >>> 0, _newW = u32[_base + _stale] >>> 0;
                region.pcMap.delete(pc >>> 0);
                self.__vecWord.delete(pc >>> 0);
                region = null; idx = -1;
                if ((self.__vecStale = (self.__vecStale | 0) + 1) <= 8)
                  postMessage({ cmd: 'print', txt: '[vec-check] stale vector block dropped pc=0x' + pc.toString(16)
                    + ' word[' + _stale + ']@0x' + ((pc + _stale * 4) >>> 0).toString(16)
                    + ' 0x' + _oldW.toString(16) + ' -> 0x' + _newW.toString(16)
                    + ' mem1Base=0x' + (mem1Base >>> 0).toString(16) });
              }
            }
          }
          if (!region && self.__aot && self.__aot.enabled && self.__aot.map.has(pc >>> 0)) {
            // [AoT — Task 2] pre-compiled function pack hit: instantiate the owning
            // function's module once, register ALL its block pcs as pseudo-instances
            // ({exports:{run}} — the dispatcher's inst.exports.run fallback), dispatch.
            const _a = self.__aot;
            const _ent = _a.map.get(pc >>> 0);
            const _fi = _ent[0], _li = _ent[1];
            let _inst = _a.instCache[_fi];
            if (_inst === undefined) {
              try {
                const _off = _a.funcs[_fi * 5 + 1], _sz = _a.funcs[_fi * 5 + 2];
                const _wm = new WebAssembly.Module(_a.pack.subarray(_off, _off + _sz));
                _inst = new WebAssembly.Instance(_wm, mod.bemental_imports ? { env: mod.bemental_imports.env } : {});
              } catch (e) {
                _inst = null;
                if ((self.__aotFail = (self.__aotFail | 0) + 1) <= 4)
                  postMessage({ cmd: 'print', txt: '[aot] instantiate fail f' + _fi + ': ' + (e && e.message) });
              }
              _a.instCache[_fi] = _inst;
            }
            if (_inst) {
              if (!regions[0]) regions[0] = { pcMap: new Map(), cycleMap: new Map(), instances: [] };
              const _first = _a.funcs[_fi * 5 + 3], _nb = _a.funcs[_fi * 5 + 4];
              for (let _b = 0; _b < _nb; _b++) {
                const _bpc = _a.blockPcs[_first + _b] >>> 0;
                if (regions[0].pcMap.has(_bpc)) continue;
                const _idx = regions[0].instances.length;
                regions[0].instances.push({ aot: true, exports: { run: (function (I, sel) {
                  return function () { u32[0x026B0904 >> 2] = sel; return I.exports.region() >>> 0; };
                })(_inst, _b) } });
                regions[0].pcMap.set(_bpc, _idx);
                regions[0].cycleMap.set(_bpc, 1);
              }
              if (regions[0].pcMap.has(pc >>> 0)) {
                region = regions[0]; idx = regions[0].pcMap.get(pc >>> 0); blockCycles = 1;
                if ((self.__aotHits = (self.__aotHits | 0) + 1) === 1)
                  postMessage({ cmd: 'print', txt: '[aot] first dispatch hit pc=0x' + pc.toString(16) });
              }
            }
          }
          if (!region) {
            if (!compileOnMiss) { exitReason = 'unmapped'; break; }
            // 2g: ppc-worker self-compile. Reads guest instructions from
            // SAB-mapped MEM1 directly, calls bemental::powerpc::build_block
            // in-process, returns module bytes via static buffer. Replaces
            // the cmd-13 mailbox round-trip to dolphin (which hangs once
            // dolphin's pthread is in steady-state retro_run loop).
            const bytesSize = mod._ppc_worker_compile_block(pc) >>> 0;
            const bytesOffset = mod._ppc_worker_compile_buf_addr() >>> 0;
            const cycles = mod._ppc_worker_compile_cycles() >>> 0 || 1;
            ++compileCalls;
            totalCompileBytes += bytesSize;
            if (bytesSize === 0) { exitReason = 'compile-empty'; break; }
            // Self-compile uses a single growing region; assign sequential
            // function indices into region 0.
            const regionIdx = 0;
            try {
              if (!regions[regionIdx]) {
                regions[regionIdx] = { pcMap: new Map(), cycleMap: new Map(), instances: [] };
              }
              const fnIdx = regions[regionIdx].instances.length;
              const bytes = new Uint8Array(sharedMemoryRef.buffer, bytesOffset, bytesSize).slice();
              const wmod = new WebAssembly.Module(bytes);
              const importObj = mod.bemental_imports
                ? { env: mod.bemental_imports.env } : {};
              const inst = new WebAssembly.Instance(wmod, importObj);
              regions[regionIdx].instances.push(inst);
              // [vector-page no-cache 2026-07-03] NEVER cache real-mode vector-page blocks
              // (pc < 0x4000): the early pc=0-ISI storm executes the vectors BEFORE
              // OSExceptionInit writes the real stubs, and the guest's later ICFlushRange
              // never reaches this cache — halts traced to stale pre-install stub code
              // dispatching EXT to OSDefaultExceptionHandler with a HEALTHY table
              // (seed-watch ring: 500,588 -> 800b4c54; prim-exc: no sync faults; htab intact).
              // Deliveries are ~250/s; per-delivery recompile of a tiny stub is cheap.
              // [vector no-cache ENFORCED 2026-07-07] the comment above documented
              // no-cache but the set() ran unconditionally — a stale vector block could
              // be re-dispatched from the cache between OS rewrites (the 0x594-ISI class
              // survived the full-block vec-check via paths that skip it). Vector-page
              // blocks are NEVER cached: every delivery recompiles ~250/s, trivially
              // cheap, and closes every staleness path by construction.
              if ((pc >>> 0) >= 0x4000) {
                regions[regionIdx].pcMap.set(pc >>> 0, fnIdx);
              }
              regions[regionIdx].cycleMap.set(pc >>> 0, cycles);
              if ((pc >>> 0) < 0x4000 && mem1Base) {
                // record the 32-word window (format MUST match the full-block vec-check —
                // the old single-number seed made every dispatch mismatch → perpetual
                // drop/recompile loop → the vector never serviced within its window).
                if (!self.__vecWord) self.__vecWord = new Map();
                const _vb = (mem1Base + (pc & 0x01FFFFFF)) >> 2;
                const _vr = new Uint32Array(40);
                for (let _vw = 0; _vw < 40; _vw++) _vr[_vw] = u32[_vb + _vw] >>> 0;
                self.__vecWord.set(pc >>> 0, _vr);
              }
              region = regions[regionIdx];
              idx = fnIdx;
              blockCycles = cycles;
            } catch (e) {
              exitReason = 'compile-instantiate: ' + (e && e.message ? e.message : String(e));
              break;
            }
          }
          // Same-PC idle-skip detector (port of JitWasm.cpp:3686+).
          // Increments when the same pc is dispatched repeatedly, which
          // happens for busy-wait loops (e.g., bne -8 polling SAB poll
          // patterns from sab_polling_loop_skip). After 100 same-pc
          // dispatches, exit so dolphin's CoreTiming::Idle() can
          // fast-forward to the next event.
          // [loop-window 2026-07-03] Multi-pc wait loops (e.g. the ARQ DMA wait ping-pongs
          // 0x80111a48<->0x80111bb4 — measured 7.2KB/s ARAM upload, ~2.3s per chunk) never
          // accumulate samePcCount. Track membership in a tiny 8-pc window; sustained
          // membership counts like same-pc so the sleep-tick can jump sim-time to the next
          // event. Compute loops that false-positive only get events sooner — safe.
          if (!self.__lw) self.__lw = new Uint32Array(8);
          var _inWin = false;
          for (var _wi = 0; _wi < 8; _wi++) { if (self.__lw[_wi] === (pc >>> 0)) { _inWin = true; break; } }
          if (!_inWin) {
            self.__lw[(self.__lwI = ((self.__lwI | 0) + 1) & 7)] = pc >>> 0;
          }
          self.__lwN = _inWin ? ((self.__lwN | 0) + 1) : 0;
          if (pc === lastPc || _inWin) {
            if (pc === lastPc) ++samePcCount;  // idle-skip exit keyed on SINGLE-pc only
            // [pollAdvance engage 2026-07-09] see the merged-path twin above.
            // [multi-pc engage 2026-07-09] DSPCheckMailFromDSP-class polls are CALLS in a loop
            // (3-4 pc cycle) — samePcCount resets every other dispatch and the single-pc
            // engagement never fires (roll 5: DSP_Update 5x/20s = sim-time starved). Engage
            // from the windowed detector (__lwN) too.
            if (Atomics.load(i32, 0x026A0000 >> 2) === 1
                && ((samePcCount >= 8 && (samePcCount & 7) === 0)
                    || ((self.__lwN | 0) >= 8 && ((self.__lwN | 0) & 7) === 0))) {
              if (pollAdvance(pc)) continue;
            }
            // Item 7 sleep-tick (legacy path mirror). Windowed (multi-pc) wait loops
            // drive the gt-jump but never the idle-skip exit — exiting the pass per 100
            // dispatches re-imposed the yield cadence (measured: upload rate DROPPED).
            if (samePcCount >= SLEEP_TICK_THRESHOLD || (self.__lwN | 0) >= 400) {
              // [dolphin-wake 2026-07-03] With fastmem the wait spins fully in-wasm — zero
              // mailbox traffic — and the dolphin pthread parks in its futex; hybrid events
              // (ARAM completion, VI) only fire from ITS Advance. Bimodal upload rates
              // (17KB vs 5.1MB per 120s) = whether unrelated traffic kept dolphin awake.
              // Ping it with a harmless read32 so Advance runs while we wait.
              if (((self.__dwN = (self.__dwN | 0) + 1) & 63) === 0) {
                mod._ppc_worker_mailbox_call_sync(4, 0x80000000);
              }
              // [smooth-poll, multi-pc 2026-07-07] Same semantics as the same-pc branch:
              // an EE=0 loop is a TIME-OBSERVING poll (post-crash-fix wedge: VI field poll
              // cycling 0x800c7710/7714/72fc at msr=0x32) — event-jumps alias the observed
              // value; no event can wake EE=0. Step time smoothly instead.
              {
                const _msrW = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
                if ((_msrW & 0x8000) === 0) {
                  const gtlw = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
                  const stepw = (gtlw + 2000) >>> 0;  // realtime-paced, see same-pc branch
                  u32[(CT_BASE + CT_OFF_GTL) >> 2] = stepw;
                  if (stepw < gtlw) u32[(CT_BASE + CT_OFF_GTH) >> 2] =
                    ((u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0) + 1) >>> 0;
                  mod._ppc_worker_ct_fire_due_pure(stepw, u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0);
                  u32[0x026B0E4C >> 2] = (self.__smoothN2 = (self.__smoothN2 | 0) + 1) >>> 0;
                  // [due-kick] see the same-pc branch.
                  if (u32[0x026B0918 >> 2] !== 0) {
                    const _nl2 = u32[0x026B0910 >> 2] >>> 0, _nh2 = u32[0x026B0914 >> 2] >>> 0;
                    const _gh2 = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
                    if (_gh2 > _nh2 || (_gh2 === _nh2 && stepw >= _nl2))
                      mod._ppc_worker_mailbox_call_sync(4, 0x80000000);
                  }
                  lastPc = pc;
                  Atomics.store(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, 20000);
                  self.__selfRefills = (self.__selfRefills | 0) + 1;
                  continue;
                }
              }
              const nxt = findNextEventCycles();
              if (nxt) {
                const gtl0 = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
                const gth0 = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
                const farHi = (nxt.hi >>> 0) > (gth0 >>> 0);
                const farLo = (nxt.hi === gth0) && ((nxt.lo - gtl0) >>> 0) > 1024;
                if (farHi || farLo) {
                  let newLo = (nxt.lo - 1) >>> 0;
                  let newHi = nxt.hi >>> 0;
                  if (newLo === 0xFFFFFFFF && nxt.lo === 0) newHi = (newHi - 1) >>> 0;
                  u32[(CT_BASE + CT_OFF_GTL) >> 2] = newLo;
                  u32[(CT_BASE + CT_OFF_GTH) >> 2] = newHi;
                  mod._ppc_worker_ct_fire_due_pure(newLo, newHi);
                  if (++sleepTickCount <= 4) {
                    postMessage({ cmd: 'print',
                      txt: '[ppc-worker] sleep-tick #' + sleepTickCount
                         + ' pc=0x' + pc.toString(16)
                         + ' jumpTo=0x' + newHi.toString(16) + newLo.toString(16).padStart(8,'0') });
                  }
                  samePcCount = 0;
                }
              }
            }
            if (samePcCount > 100 && !disableIdleSkip) {
              exitReason = 'idle-skip'; break;
            }
          } else {
            samePcCount = 0;
            lastPc = pc;
          }
          // Dispatch. 2g self-compile uses one Instance per block in
          // region.instances[]; legacy mailbox path stores a single
          // multi-block instance in region.exports.
          let fn;
          if (region.instances) {
            const inst = region.instances[idx];
            fn = inst && (inst.exports['block' + idx] || inst.exports.block0 || inst.exports.run);
          } else {
            fn = region.exports['block' + idx] || region.exports.run;
          }
          if (typeof fn !== 'function') { exitReason = 'no-block-export'; break; }
          let nextPc;
          // [aot-chain] chained dispatches charge downcount INSIDE wasm across many
          // blocks; derive cycles from the downcount delta (for gt-advance accounting)
          // and skip the loop's own subtract to avoid double-charging.
          const _isAotChain = !!(region.instances && region.instances[idx] && region.instances[idx].aot);
          const _dc0 = _isAotChain ? i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2] : 0;
          try {
            nextPc = fn() >>> 0;
          } catch (e) {
            exitReason = 'block-trap: ' + (e && e.message ? e.message : String(e));
            break;
          }
          if (_isAotChain) {
            let _burn = (_dc0 - i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2]) | 0;
            if (_burn < 1) _burn = 1;
            sliceCyclesBurned += _burn;
          } else {
          // Decrement downcount per dispatch (post-2f.0 cycles plumbing).
          // Use Atomics.sub to keep this race-free with dolphin's parallel
          // Run() until 2f.2 wires the yield handshake. In perf mode we
          // skip this (downcount accounting is dolphin's job there).
          if (!ignoreDowncount) {
            Atomics.sub(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, blockCycles);
          }
          sliceCyclesBurned += blockCycles;
          }
          // Update SAB pc to the new value (block return is canonical
          // per Q2 finding).
          u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] = nextPc;
          // [b7a58-trace 2026-07-08] ExternalInterruptHandler (0x800b7a58) ends with
          // `b __OSDispatchInterrupt (0x800b7714)`; the vec-trace showed the worker going
          // to 0x500 instead. Capture the ACTUAL nextPc this block returns + msr/exc, to
          // see if the branch produces 0x800b7714 (emitter OK, delivery intervenes) or a
          // wrong target (emitter bug). 0x026B0A34=count,+4=nextPc,+8=msr,+C=exc.
          if ((pc >>> 0) === 0x800b7a58) {
            u32[0x026B0A34 >> 2] = (u32[0x026B0A34 >> 2] >>> 0) + 1;
            u32[0x026B0A38 >> 2] = nextPc >>> 0;
            u32[0x026B0A3C >> 2] = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
            u32[0x026B0A40 >> 2] = u32[(PPC_STATE_BASE + OFFSET_EXC) >> 2] >>> 0;
          }
          pc = nextPc;
        }
        // Phase IV commit: advance SAB global_timer atomically and fire
        // any due pure-PPC events. The downcount math above already
        // subtracted the per-block cycles; commit_slice's own
        // __atomic_sub_fetch is a second decrement of the EXACT same
        // total, which is wrong. So instead of having commit_slice
        // subtract, we pass 0 here and only let it advance the timer
        // + fire events — keeping the existing per-block Atomics.sub
        // as canonical. Equivalent to ppc_worker_advance_global_timer +
        // ppc_worker_ct_fire_due_pure but in one C call.
        // Phase 2e fix: advance only the residual cycles not already
        // pushed by the per-iter CT-fire path. Without this guard, mid-
        // slice advances would double-count and global_timer would race
        // ahead of emulated execution.
        {
          const residual = (sliceCyclesBurned - cyclesAdvancedSoFar) >>> 0;
          if (residual > 0 && typeof mod._ppc_worker_advance_global_timer === 'function') {
            const gtl0 = u32[(CT_BASE + CT_OFF_GTL) >> 2] >>> 0;
            const gth0 = u32[(CT_BASE + CT_OFF_GTH) >> 2] >>> 0;
            const sumLo = (gtl0 + residual) >>> 0;
            const carry = (sumLo < gtl0) ? 1 : 0;
            const sumHi = (gth0 + carry) >>> 0;
            mod._ppc_worker_advance_global_timer(sumLo, sumHi);
            mod._ppc_worker_ct_fire_due_pure(sumLo, sumHi);
          }
        }
        // [determinize-boot / atomics-only loop 2026-07-08] Re-engage decision.
        // Benign slice boundaries (the worker owns the CPU and just ran out of slice) do
        // NOT need the page: service dolphin synchronously via the mailbox (each cmd-4 runs
        // one dolphin_service_iter in-process, Atomics-blocking = deterministic ordering)
        // a FIXED count, then re-run the slice. Only genuine exits (exception the page must
        // route, stop-flag, owner lost, trap) post the ack + break to the switch.
        {
          const _ownerNow = Atomics.load(i32, 0x026A0000 >> 2);
          const _stop = Atomics.load(i32, 0x02500004 >> 2);
          const _benignExit = (exitReason === 'slice-budget'
                            || exitReason === 'downcount-exhausted'
                            || exitReason === 'safety-cap');
          if (_ownerNow === 1 && _stop === 0 && _benignExit) {
            // deterministic dolphin service (drain mailbox + Advance + tick devices)
            for (let _s = 0; _s < 4; _s++) mod._ppc_worker_mailbox_call_sync(4, 0x80000000);
            continue;  // re-run the slice internally — no postMessage round-trip
          }
        }
        Atomics.store(i32, 0x026B1A00 >> 2, 0);  // [slice-active clear — true slice exit]
        postMessage({
          cmd: 'run-continuous-ack',
          iters, lastPc: pc, exitReason, compileCalls, totalCompileBytes,
          samePcCount, sliceCyclesBurned,
        });
        _sliceLoop = false;
        }
        break;
      }
      case 'mailbox-call': {
        // Phase 2c.4c: synchronous request-reply. ppc-worker C++
        // publishes (mboxCmd, arg0) into the mailbox slot, Atomics.waits
        // for the consumer (page) to write reply + reply_ready.
        // BLOCKS this worker until the page responds.
        if (!inited) { postMessage({ cmd: 'mailbox-call-nack', reason: 'not initialised' }); return; }
        const reply = mod._ppc_worker_mailbox_call_sync(
          (data.mboxCmd | 0) >>> 0, (data.arg0 | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'mailbox-call-ack', reply });
        break;
      }
      case 'shutdown': {
        if (mod) mod._ppc_worker_shutdown();
        postMessage({ cmd: 'shutdown-ack' });
        break;
      }
      default:
        postMessage({ cmd: 'error', error: 'unknown cmd: ' + data.cmd });
    }
  };
})();
