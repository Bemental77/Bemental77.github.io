// jit_params.js — decode the JIT bridge's param block (recomp.c jit_params[]).
//
// Moved verbatim out of n64/index.html's setupJitBridge so that the page and
// the worker-hosted core (core_worker.js) decode the block ONE way: the
// emitter stores through these addresses, so a decode that drifted between the
// two realms would corrupt guest memory on one of them only.
//   __n64JitParams(M, paramsPtr) -> the object bementalMips.compileSpan takes
(function (root) {
  root.__n64JitParams = function (M, paramsPtr) {
    var q = paramsPtr >> 2, H = M.HEAPU32;
    return {
      vaddr: H[q], entryPtr: H[q + 1], span: H[q + 2],
      srcPtr: H[q + 3], stride: H[q + 4], addrOff: H[q + 5],
      pcGlobal: H[q + 6], reg: H[q + 7], hi: H[q + 8], lo: H[q + 9],
      blockStart: H[q + 10], blockEnd: H[q + 11], lastAddr: H[q + 12],
      nextInt: H[q + 13], count: H[q + 14], cpo: H[q + 15],
      skipJump: H[q + 16], genInt: H[q + 17],
      readmemW: H[q + 18], readmemB: H[q + 19], readmemH: H[q + 20],
      rdRdram: H[q + 21], rdRdramB: H[q + 22], rdRdramH: H[q + 23],
      dramBase: H[q + 24],
      writememW: H[q + 25], writememB: H[q + 26], writememH: H[q + 27],
      wrRdram: H[q + 28], wrRdramB: H[q + 29], wrRdramH: H[q + 30],
      invalidCode: H[q + 31], blocksBase: H[q + 32], notCompiled: H[q + 33],
      cp1Simple: H[q + 34], cp1Double: H[q + 35], cp0Status: H[q + 36],
      readmemD: H[q + 37], writememD: H[q + 38],
      rdRdramD: H[q + 39], wrRdramD: H[q + 40],
      jumpToAddr: H[q + 41], jumpToFunc: H[q + 42],
      // wave 11b: &FCR31, but ONLY when the core stamped the param-block
      // version magic at index 44. A core built before wave 11b has a
      // 43-entry array, so reading index 43 would return whatever static
      // data follows it — and the emitter would STORE the FP condition bit
      // through that address. The magic makes a page/core skew fall back
      // (compares + BC1 stay on the interpreter) instead of corrupting
      // guest memory. recomp.c stamps it next to the pointer it guards.
      fcr31: (H[q + 44] === 0x4E36344B) ? H[q + 43] : 0,
      // &g_dev.r4300.delay_slot. Behind the SAME version magic — a block
      // entry that is reachable as a branch DELAY SLOT must run exactly one
      // instruction, and without this address the emitter cannot tell.
      // A core too old to carry it yields 0, and the emitter then refuses to
      // compile any span at all rather than install an unsafe block.
      delaySlot: (H[q + 44] === 0x4E36344B) ? H[q + 45] : 0,
    };
  };
})(typeof window !== 'undefined' ? window : self);
